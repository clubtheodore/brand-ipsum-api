import OpenAI from "openai"
import { Redis } from "@upstash/redis"

const CACHE_TTL_SECONDS = 60 * 60 * 24 * 7
const MAX_EXTRA_PAGES = 2
const MAX_CHARS_PER_PAGE = 7500

const client = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
})

const redis =
    process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN
        ? new Redis({
              url: process.env.KV_REST_API_URL,
              token: process.env.KV_REST_API_TOKEN,
          })
        : null

function normalizeUrl(input) {
    let value = input.trim()

    if (!/^https?:\/\//i.test(value)) {
        value = `https://${value}`
    }

    return new URL(value)
}

function normalizeHostname(hostname) {
    return hostname.toLowerCase().replace(/^www\./, "")
}

function sameDomain(url, hostname) {
    try {
        return normalizeHostname(new URL(url).hostname) === hostname
    } catch {
        return false
    }
}

function scoreEvergreenUrl(url) {
    const value = url.toLowerCase()

    // Très intéressantes pour comprendre durablement la marque
    const highPriority = [
        "about",
        "about-us",
        "our-story",
        "story",
        "history",
        "heritage",
        "mission",
        "values",
        "philosophy",
        "manifesto",
        "company",
        "who-we-are",
        "maison",
        "savoir-faire",
        "craft",
        "craftsmanship",
        "editorial-principles",
        "editorial",
    ]

    // Intéressantes pour comprendre l'offre fondamentale
    const mediumPriority = [
        "products",
        "product",
        "services",
        "platform",
        "solutions",
        "collections",
        "collection",
        "technology",
        "design",
    ]

    // Contenu très temporaire ou peu utile pour Brand Ipsum
    const negative = [
        "sale",
        "discount",
        "offers",
        "new-arrivals",
        "new-in",
        "latest",
        "news",
        "blog",
        "article",
        "press",
        "login",
        "signin",
        "account",
        "cart",
        "checkout",
        "privacy",
        "terms",
        "legal",
        "cookie",
        "contact",
        "careers",
        "jobs",
    ]

    let score = 0

    for (const word of highPriority) {
        if (value.includes(word)) score += 10
    }

    for (const word of mediumPriority) {
        if (value.includes(word)) score += 4
    }

    for (const word of negative) {
        if (value.includes(word)) score -= 8
    }

    return score
}

function selectEvergreenPages(links, hostname, homepageUrl) {
    const home = homepageUrl.replace(/\/$/, "")

    const cleanLinks = links
        .map((item) => {
            if (typeof item === "string") return item
            if (item && typeof item.url === "string") return item.url
            return null
        })
        .filter(Boolean)
        .map((url) => url.split("#")[0])
        .filter((url) => !url.includes("?"))
        .filter((url) => sameDomain(url, hostname))
        .filter((url) => url.replace(/\/$/, "") !== home)

    const unique = [...new Set(cleanLinks)]

    return unique
        .map((url) => ({
            url,
            score: scoreEvergreenUrl(url),
        }))
        .filter((item) => item.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, MAX_EXTRA_PAGES)
        .map((item) => item.url)
}

async function scrapePage(url, includeLinks = false) {
    const response = await fetch(
        "https://api.firecrawl.dev/v2/scrape",
        {
            method: "POST",
            headers: {
                Authorization: `Bearer ${process.env.FIRECRAWL_API_KEY}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                url,
                formats: includeLinks
                    ? ["markdown", "links"]
                    : ["markdown"],
                onlyMainContent: true,
                removeBase64Images: true,
                blockAds: true,

                // Évite le retry automatique avec proxy enhanced,
                // qui peut coûter plus de crédits.
                proxy: "basic",

                // Autorise Firecrawl à réutiliser son cache
                maxAge: 604800000,

                timeout: 30000,
            }),
        }
    )

    const data = await response.json()

    if (!response.ok || !data.success) {
        throw new Error(
            data.error || `Firecrawl failed for ${url}`
        )
    }

    return {
        markdown: data.data?.markdown || "",
        links: data.data?.links || [],
    }
}

function formatPageForPrompt(label, url, markdown) {
    return `
### ${label}
URL: ${url}

${markdown.slice(0, MAX_CHARS_PER_PAGE)}
`
}

const brandSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
        name: {
            type: "string",
        },
        iconic: {
            type: "array",
            items: { type: "string" },
        },
        products: {
            type: "array",
            items: { type: "string" },
        },
        people: {
            type: "array",
            items: { type: "string" },
        },
        places: {
            type: "array",
            items: { type: "string" },
        },
        vocabulary: {
            type: "array",
            items: { type: "string" },
        },
        everyday: {
            type: "array",
            items: { type: "string" },
        },
        tone: {
            type: "array",
            items: { type: "string" },
        },
    },
    required: [
        "name",
        "iconic",
        "products",
        "people",
        "places",
        "vocabulary",
        "everyday",
        "tone",
    ],
}

export default async function handler(req, res) {
    res.setHeader("Access-Control-Allow-Origin", "*")
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS")
    res.setHeader(
        "Access-Control-Allow-Headers",
        "Content-Type"
    )

    if (req.method === "OPTIONS") {
        return res.status(200).end()
    }

    if (req.method !== "POST") {
        return res.status(405).json({
            error: "Method not allowed",
        })
    }

    try {
        if (!process.env.OPENAI_API_KEY) {
            return res.status(500).json({
                error: "OPENAI_API_KEY is missing",
            })
        }

        if (!process.env.FIRECRAWL_API_KEY) {
            return res.status(500).json({
                error: "FIRECRAWL_API_KEY is missing",
            })
        }

        const { url } = req.body || {}

        if (!url) {
            return res.status(400).json({
                error: "URL is required",
            })
        }

        const parsedUrl = normalizeUrl(url)
        const hostname = normalizeHostname(
            parsedUrl.hostname
        )

        const homepageUrl = `${parsedUrl.protocol}//${parsedUrl.host}`

        const cacheKey = `brand-ipsum:v2:${hostname}`

        // 1 — Vérifier le cache Redis
        if (redis) {
            try {
                const cachedBrand =
                    await redis.get(cacheKey)

                if (cachedBrand) {
                    return res.status(200).json({
                        brand: cachedBrand,
                        meta: {
                            source: "cache",
                            hostname,
                        },
                    })
                }
            } catch (error) {
                console.error(
                    "Redis read failed:",
                    error
                )
            }
        }

        // 2 — Scraper la home + récupérer ses liens
        const homepage = await scrapePage(
            homepageUrl,
            true
        )

        if (!homepage.markdown) {
            throw new Error(
                "No usable homepage content found"
            )
        }

        // 3 — Choisir maximum deux pages evergreen
        const evergreenUrls =
            selectEvergreenPages(
                homepage.links,
                hostname,
                homepageUrl
            )

        // 4 — Scraper ces pages en parallèle
        const extraPages = await Promise.all(
            evergreenUrls.map(async (pageUrl) => {
                try {
                    const page =
                        await scrapePage(pageUrl)

                    return {
                        url: pageUrl,
                        markdown: page.markdown,
                    }
                } catch (error) {
                    console.error(
                        `Extra page scrape failed: ${pageUrl}`,
                        error
                    )

                    return null
                }
            })
        )

        const usableExtraPages =
            extraPages.filter(Boolean)

        // 5 — Construire un contexte court
        let websiteContext =
            formatPageForPrompt(
                "Homepage",
                homepageUrl,
                homepage.markdown
            )

        usableExtraPages.forEach(
            (page, index) => {
                websiteContext +=
                    formatPageForPrompt(
                        `Evergreen page ${index + 1}`,
                        page.url,
                        page.markdown
                    )
            }
        )

        // 6 — Un seul appel OpenAI
        const response =
            await client.responses.create({
                model: "gpt-4.1-mini",

                input: `
You are creating the brand vocabulary for Brand Ipsum, a playful branded Lorem Ipsum generator.

Your job is NOT to summarize the website.
Your job is to identify the durable, recognizable identity of the brand.

DOMAIN:
${hostname}

WEBSITE CONTENT:
${websiteContext}

CORE PRINCIPLE

Separate permanent brand identity from temporary website content.

The final vocabulary should still feel recognizably true to the brand six months or several years from now.

PRIORITIZE

1. Iconic and distinctive references:
   slogans, symbols, signature concepts, recurring franchises, historically important ideas.

2. Signature products or services:
   well-known product names, permanent product families, core services and recurring offers.

3. People:
   founders, designers, executives, ambassadors or culturally important people strongly associated with the brand.

4. Places:
   headquarters, founding locations, iconic stores, factories, studios or geographic references genuinely linked to the brand.

5. Distinctive vocabulary:
   words the brand repeatedly uses or concepts strongly associated with its identity.

6. Everyday concrete vocabulary:
   objects, materials, activities, interfaces, places or actions naturally connected to the brand.

7. Tone:
   a few concise adjectives describing the brand's lasting communication style.

TEMPORARY CONTENT

Downweight or ignore:
- sales and discounts
- temporary promotions
- current campaigns unless historically iconic
- seasonal collections
- "new arrivals"
- current news events
- individual articles
- short-lived homepage merchandising
- SEO boilerplate
- cookie / legal / navigation language

ECOMMERCE RULE

If this is an ecommerce brand:
- favor signature products, permanent product families, materials, craft, design codes, heritage and recurring terminology;
- do not let today's featured products or promotions dominate the result.

MEDIA / NEWS RULE

If this is a news, media or publishing brand:
- focus on editorial identity, recurring sections, signature formats, history, mission and journalistic vocabulary;
- do NOT include current politicians, wars, sports results, celebrities or today's headlines simply because they appear on the homepage;
- include a named topic/person only if it is structurally associated with the publication itself.

SAAS / TECHNOLOGY RULE

If this is a software or technology company:
- favor core products, product concepts, interface vocabulary, recurring features, founders and durable positioning;
- ignore temporary release announcements unless they represent a major permanent product.

LANGUAGE

Use the language most naturally associated with the brand and the supplied website.
For a predominantly French brand/site, return the brand vocabulary in French.
Keep official product names and proper nouns in their original form.

QUALITY

Prefer specific and concrete terms over generic marketing words.

Good:
"Air Max", "Swoosh", "Birkin", "Apple Park", "Wrapped"

Weak:
"innovation", "quality", "excellence", "customer-centric"

Generic terms may appear only when they are genuinely central to the brand.

Do not invent unsupported facts.
Avoid duplicate or near-duplicate entries.
Keep arrays concise and useful for text generation.
`,

                text: {
                    format: {
                        type: "json_schema",
                        name: "brand_profile",
                        strict: true,
                        schema: brandSchema,
                    },
                },
            })

        const brand = JSON.parse(
            response.output_text
        )

        // 7 — Enregistrer 7 jours dans Redis
        if (redis) {
            try {
                await redis.set(
                    cacheKey,
                    brand,
                    {
                        ex: CACHE_TTL_SECONDS,
                    }
                )
            } catch (error) {
                console.error(
                    "Redis write failed:",
                    error
                )
            }
        }

        return res.status(200).json({
            brand,
            meta: {
                source: "fresh",
                hostname,
                pagesUsed: [
                    homepageUrl,
                    ...usableExtraPages.map(
                        (page) => page.url
                    ),
                ],
            },
        })
    } catch (error) {
        console.error(
            "Brand Ipsum API error:",
            error
        )

        return res.status(500).json({
            error:
                error instanceof Error
                    ? error.message
                    : "Unknown server error",
        })
    }
}
