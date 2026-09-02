import OpenAI from "openai"
import { Redis } from "@upstash/redis"

const CACHE_TTL_SECONDS = 60 * 60 * 24 * 7

const FIRECRAWL_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 7

const MAX_HOME_CHARS = 5000
const MAX_EXTRA_PAGE_CHARS = 4500
const MAX_EXTRA_PAGES = 2

const MIN_EXTRA_PAGE_SCORE = 12

const client = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
})

const redisUrl =
    process.env.KV_REST_API_URL ||
    process.env.UPSTASH_REDIS_REST_URL

const redisToken =
    process.env.KV_REST_API_TOKEN ||
    process.env.UPSTASH_REDIS_REST_TOKEN

const redis =
    redisUrl && redisToken
        ? new Redis({
              url: redisUrl,
              token: redisToken,
          })
        : null

function normalizeUrl(input) {
    let value = input.trim()

    if (!/^https?:\/\//i.test(value)) {
        value = `https://${value}`
    }

    const parsed = new URL(value)

    if (
        parsed.protocol !== "http:" &&
        parsed.protocol !== "https:"
    ) {
        throw new Error("Unsupported URL protocol")
    }

    return parsed
}

function normalizeHostname(hostname) {
    return hostname
        .toLowerCase()
        .replace(/^www\./, "")
}

function sameDomain(url, hostname) {
    try {
        return (
            normalizeHostname(new URL(url).hostname) ===
            hostname
        )
    } catch {
        return false
    }
}

function pathContains(pathname, term) {
    const escaped = term.replace(
        /[.*+?^${}()|[\]\\]/g,
        "\\$&"
    )

    const regex = new RegExp(
        `(?:^|[\\/_-])${escaped}(?:[\\/_-]|$)`,
        "i"
    )

    return regex.test(pathname)
}

function getPathDepth(url) {
    try {
        let segments = new URL(url).pathname
            .split("/")
            .filter(Boolean)

        // Ignore structural / locale prefixes such as:
        // /global/en/
        // /en/
        // /fr-fr/
        // /en-us/
        segments = segments.filter((segment, index) => {
            const value = segment.toLowerCase()

            if (index === 0 && value === "global") {
                return false
            }

            if (
                /^[a-z]{2}$/.test(value) ||
                /^[a-z]{2}-[a-z]{2}$/.test(value)
            ) {
                return false
            }

            return true
        })

        return segments.length
    } catch {
        return 99
    }
}

function scoreEvergreenUrl(url) {
    let parsed

    try {
        parsed = new URL(url)
    } catch {
        return {
            score: -999,
            kind: "other",
        }
    }

    const path = parsed.pathname.toLowerCase()

    // Pages que l'on ne veut presque jamais utiliser
    const hardNegativePatterns = [
        "/story/",
        "/blog/",
        "/blogs/",
        "/article/",
        "/articles/",
        "/news/",
        "/latest/",
        "/press/",
        "/guide/",
        "/guides/",
        "/use-case/",
        "/use-cases/",
        "/case-study/",
        "/case-studies/",
        "/shop/",
        "/collection/",
        "/collections/",
        "/category/",
        "/categories/",
        "/sale/",
        "/offers/",
        "/new-arrivals/",
        "/search/",
        "/login/",
        "/signin/",
        "/account/",
        "/cart/",
        "/checkout/",
        "/privacy/",
        "/terms/",
        "/legal/",
        "/cookies/",
        "/careers/",
        "/jobs/",
        "/support/",
        "/help/",
        "/resources/",
"/resource/",
"/customer-service/",
    ]

    if (
        hardNegativePatterns.some((pattern) =>
            path.includes(pattern)
        )
    ) {
        return {
            score: -100,
            kind: "other",
        }
    }

    // Les pages type "product-story" sont également temporaires
    if (
        path.includes("product-story") ||
        path.includes("customer-story")
    ) {
        return {
            score: -100,
            kind: "other",
        }
    }

    let score = 0
    let kind = "other"
    if (path.includes("/stories/")) {
    score -= 8
}

    const identityTerms = [
        ["about-us", 35],
        ["who-we-are", 35],
        ["our-business", 30],
["how-we-work", 30],
["our-roots", 28],
["culture-and-values", 30],
["culture", 18],
["business-idea", 24],
["vision", 20],
        ["our-history", 35],
        ["our-story", 32],
        ["heritage", 30],
        ["history", 28],
        ["mission", 28],
        ["company", 26],
        ["values", 24],
        ["manifesto", 24],
        ["philosophy", 22],
        ["craftsmanship", 24],
        ["savoir-faire", 24],
        ["craft", 20],
        ["purpose", 20],
        ["ownership", 20],
        ["our-footprint", 20],
        ["responsibility", 18],
        ["sustainability", 18],
        ["impact", 16],
        ["editorials", 20],
        ["editorial", 18],
        ["about", 24],
    ]

    for (const [term, points] of identityTerms) {
        if (pathContains(path, term)) {
            score += points
            kind = "identity"
        }
    }

    const offeringTerms = [
        ["products", 18],
        ["product", 14],
        ["platform", 18],
        ["features", 16],
        ["services", 14],
        ["solutions", 12],
        ["technology", 12],
        ["design", 12],
    ]

    for (const [term, points] of offeringTerms) {
        if (pathContains(path, term)) {
            score += points

            if (kind === "other") {
                kind = "offering"
            }
        }
    }

    // Pages datées = probablement contenu temporaire
    if (/\/20\d{2}\//.test(path)) {
        score -= 18
    }

    // Slugs de type 260121 / 20260731
    if (/(?:^|[-_/])\d{6,8}(?:[-_/]|$)/.test(path)) {
        score -= 15
    }
// Les pages explicitement "stock" reflètent souvent
// une disponibilité commerciale ponctuelle plutôt
// qu'un produit signature durable.
if (
    path.includes("-stock") ||
    path.includes("/stock/")
) {
    score -= 30
}
    
    // Plus une page est profonde, plus elle risque
    // de parler d'un sujet très spécifique
    const depth = getPathDepth(url)

    if (depth > 2) {
        score -= (depth - 2) * 5
    }

    return {
        score,
        kind,
    }
}

function inferSiteType(markdown, links = []) {
    const paths = links
        .map((item) => {
            const url =
                typeof item === "string"
                    ? item
                    : item?.url

            if (!url) {
                return ""
            }

            try {
                return new URL(url)
                    .pathname
                    .toLowerCase()
            } catch {
                return ""
            }
        })
        .filter(Boolean)

    const count = (pattern) =>
        paths.filter((path) =>
            pattern.test(path)
        ).length

    let mediaScore =
        count(
            /\/(?:article|articles|news)\//i
        ) * 3 +
        count(/\/20\d{2}\//i) * 2 +
        count(
            /_\d{5,}_\d+\.html$/i
        ) * 3

    let ecommerceScore =
        count(
            /\/(?:shop|products|collections?|cart|checkout|category|categories|cat|rooms)\//i
        ) * 2

    let saasScore =
        count(
            /\/(?:features?|pricing|integrations?|developers?|docs?|api|platform|solutions?)(?:\/|$)/i
        ) * 2 +
        count(/\/product(?:\/|$)/i)

    const text =
        String(markdown || "")
            .toLowerCase()
            .slice(0, 12000)

    if (
        /\b(add to cart|shopping bag|panier|ajouter au panier|checkout)\b/i.test(
            text
        )
    ) {
        ecommerceScore += 5
    }

    if (
        /\b(api|workspace|workflow|software|platform|developer)\b/i.test(
            text
        )
    ) {
        saasScore += 3
    }

    if (
        /\b(journal|journalisme|news|article|reportage|chronique)\b/i.test(
            text
        )
    ) {
        mediaScore += 3
    }

    if (
        mediaScore >= 8 &&
        mediaScore > ecommerceScore &&
        mediaScore > saasScore
    ) {
        return "media"
    }

    if (
        ecommerceScore >= 6 &&
        ecommerceScore >= saasScore
    ) {
        return "ecommerce"
    }

    if (saasScore >= 4) {
        return "saas"
    }

    return "other"
}

function isProductEvidenceUrl(
    url,
    siteType
) {
    let path = ""

    try {
        path =
            new URL(url)
                .pathname
                .toLowerCase()
    } catch {
        return false
    }

    if (siteType === "media") {
        return false
    }

    if (siteType === "ecommerce") {
        return (
            pathContains(
                path,
                "product"
            ) ||
            pathContains(
                path,
                "products"
            )
        )
    }

   if (siteType === "saas") {
    const normalized =
        path.replace(/\/+$/, "")

    const rejectedSaasPaths = [
        "/templates/",
        "/template/",
        "/marketplace/",
        "/help/",
        "/guides/",
        "/blog/",
        "/resources/",
    ]

    if (
        rejectedSaasPaths.some(
            (pattern) =>
                path.includes(pattern)
        )
    ) {
        return false
    }

    return (
        normalized.endsWith(
            "/product"
        ) ||
        normalized.endsWith(
            "/products"
        ) ||
        pathContains(
            path,
            "platform"
        )
    )
}

    return (
        scoreEvergreenUrl(url).kind ===
        "offering"
    )
}

function selectEvergreenPages(
    links,
    hostname,
    homepageUrl,
    language = "en"
) {
    const homepage =
        homepageUrl.replace(/\/$/, "")

    const targetLanguage =
        String(language)
            .toLowerCase()
            .split("-")[0]

    function getExplicitUrlLanguage(url) {
        try {
            const segments =
                new URL(url).pathname
                    .toLowerCase()
                    .split("/")
                    .filter(Boolean)

            let first =
                segments[0] || ""

            if (first === "global") {
                first =
                    segments[1] || ""
            }

            const match =
                first.match(
                    /^([a-z]{2})(?:-[a-z]{2})?$/
                )

            return match
                ? match[1]
                : null
        } catch {
            return null
        }
    }

    const candidates = links
        .map((item) => {
            if (typeof item === "string") {
                return item
            }

            if (
                item &&
                typeof item.url === "string"
            ) {
                return item.url
            }

            return null
        })
        .filter(Boolean)
        .map((url) => {
            try {
                const parsed =
                    new URL(url)

                parsed.hash = ""
                parsed.search = ""

                return parsed.toString()
            } catch {
                return null
            }
        })
        .filter(Boolean)
        .filter((url) =>
            sameDomain(url, hostname)
        )
        .filter(
            (url) =>
                url.replace(/\/$/, "") !==
                homepage
        )

    const unique =
        [...new Set(candidates)]

    const scored = unique
        .map((url) => {
            const result =
                scoreEvergreenUrl(url)

            // La langue peut départager
            // de bonnes pages, mais ne doit
            // jamais rendre une mauvaise page
            // éligible.
            if (
                result.score <
                MIN_EXTRA_PAGE_SCORE
            ) {
                return null
            }

            const urlLanguage =
                getExplicitUrlLanguage(
                    url
                )

            let languageScore = 0

            if (
                urlLanguage ===
                targetLanguage
            ) {
                languageScore = 25
            } else if (
                urlLanguage &&
                urlLanguage !==
                    targetLanguage
            ) {
                // Une langue étrangère
                // explicitement indiquée
                // est toujours pénalisée.
                languageScore = -40
            }

            return {
                url,
                score:
                    result.score +
                    languageScore,
                kind: result.kind,
            }
        })
        .filter(Boolean)
        .filter(
            (item) =>
                item.score >=
                MIN_EXTRA_PAGE_SCORE
        )
        .sort((a, b) => {
            if (
                b.score !==
                a.score
            ) {
                return (
                    b.score -
                    a.score
                )
            }

            return (
                getPathDepth(a.url) -
                getPathDepth(b.url)
            )
        })

    const selected = []

    // 1. D'abord une page identité
    const identity = scored.find(
        (item) =>
            item.kind === "identity"
    )

    if (identity) {
        selected.push(identity)
    }

    // 2. Puis une page produit/core offer
    const offering = scored.find(
        (item) =>
            item.kind === "offering" &&
            !selected.some(
                (selectedItem) =>
                    selectedItem.url ===
                    item.url
            )
    )

    if (
        offering &&
        selected.length <
            MAX_EXTRA_PAGES
    ) {
        selected.push(offering)
    }

    // 3. Compléter uniquement avec
    // une autre bonne page si nécessaire
    for (const candidate of scored) {
        if (
            selected.length >=
            MAX_EXTRA_PAGES
        ) {
            break
        }

        if (
            !selected.some(
                (item) =>
                    item.url ===
                    candidate.url
            )
        ) {
            selected.push(candidate)
        }
    }

    return selected.map(
        (item) => item.url
    )
}

async function searchEvergreenPages(
    hostname,
    language = "en",
    locale = "en-US",
    siteType = "other"
) {
    let searchCountry = null

    try {
        searchCountry =
            new Intl.Locale(locale)
                .region || null
    } catch {
        searchCountry = null
    }

    const brandHint =
        hostname
            .split(".")[0]
            .replace(/-/g, " ")

    let productQuery = null
    let identityQuery = null

    if (siteType === "ecommerce") {
        productQuery =
            language === "fr"
                ? `${brandHint} produits iconiques produits signature best-sellers collections permanentes`
                : `${brandHint} iconic products signature products best sellers permanent collections`

        identityQuery =
            language === "fr"
                ? `${brandHint} histoire marque mission valeurs savoir-faire`
                : `${brandHint} brand story mission values heritage`
    } else if (
        siteType === "saas"
    ) {
        productQuery =
            language === "fr"
                ? `${brandHint} produits plateforme modules produits principaux offres principales`
                : `${brandHint} products platform modules core products main offerings`

        identityQuery =
            language === "fr"
                ? `${brandHint} entreprise histoire mission plateforme`
                : `${brandHint} company history mission platform`
    } else if (
        siteType === "media"
    ) {
        identityQuery =
            language === "fr"
                ? `${brandHint} histoire journal mission rédaction charte éditoriale`
                : `${brandHint} publication history mission newsroom editorial standards`
    } else {
        productQuery =
            language === "fr"
                ? `${brandHint} produits services offres principales`
                : `${brandHint} products services main offerings`

        identityQuery =
            language === "fr"
                ? `${brandHint} histoire marque mission valeurs`
                : `${brandHint} brand story mission values`
    }

    async function runSearch(
        query,
        limit
    ) {
        const response = await fetch(
            "https://api.firecrawl.dev/v2/search",
            {
                method: "POST",

                headers: {
                    Authorization:
                        `Bearer ${process.env.FIRECRAWL_API_KEY}`,
                    "Content-Type":
                        "application/json",
                },

                body: JSON.stringify({
                    query,
                    sources: ["web"],
                    includeDomains: [
                        hostname,
                    ],
                    country:
                        searchCountry ||
                        undefined,
                    limit,
                    ignoreInvalidURLs:
                        true,
                    timeout: 30000,
                }),
            }
        )

        const rawText =
            await response.text()

        let data = null

        try {
            data =
                JSON.parse(rawText)
        } catch {
            throw new Error(
                `Firecrawl search returned invalid JSON (${response.status}): ${rawText.slice(0, 200)}`
            )
        }

        if (
            !response.ok ||
            !data?.success
        ) {
            throw new Error(
                data?.error ||
                    `Firecrawl search failed (${response.status})`
            )
        }

        return data.data?.web || []
    }

    const [
        rawProductResults,
        rawIdentityResults,
    ] = await Promise.all([
        productQuery
            ? runSearch(
                  productQuery,
                  10
              )
            : Promise.resolve([]),

        runSearch(
            identityQuery,
            6
        ),
    ])

    const productResults =
        rawProductResults.map(
            (item) => ({
                ...item,
                discoveryKind:
                    "product",
            })
        )

    const identityResults =
        rawIdentityResults.map(
            (item) => ({
                ...item,
                discoveryKind:
                    "identity",
            })
        )

    const merged = []
    const seen = new Set()

    for (const item of [
        ...productResults,
        ...identityResults,
    ]) {
        if (!item?.url) {
            continue
        }

        const key =
            item.url
                .replace(/#.*$/, "")
                .replace(/\/$/, "")

        if (seen.has(key)) {
            continue
        }

        seen.add(key)
        merged.push(item)
    }

    return merged
}

async function scrapePage(
    url,
    includeLinks = false
) {
    const response = await fetch(
        "https://api.firecrawl.dev/v2/scrape",
        {
            method: "POST",

            headers: {
                Authorization: `Bearer ${process.env.FIRECRAWL_API_KEY}`,
                "Content-Type":
                    "application/json",
            },

            body: JSON.stringify({
                url,

                formats: includeLinks
                    ? ["markdown", "links"]
                    : ["markdown"],

                onlyMainContent: true,

                removeBase64Images: true,

                blockAds: true,

                proxy: "basic",

                maxAge:
                    FIRECRAWL_MAX_AGE_MS,

                timeout: 30000,
            }),
        }
    )

    const data = await response.json()

    if (
        !response.ok ||
        !data.success
    ) {
        throw new Error(
            data.error ||
                `Firecrawl failed for ${url}`
        )
    }

    return {
        markdown:
            data.data?.markdown || "",

        links:
            data.data?.links || [],
    }
}

function cleanMarkdown(markdown) {
    const lines =
        markdown.split("\n")

    const seen = new Set()

    const boilerplatePatterns = [
        /cookie preferences/i,
        /manage cookies/i,
        /accept cookies/i,
        /privacy policy/i,
        /terms of use/i,
        /all rights reserved/i,
        /skip to content/i,
        /sign in to your account/i,
    ]

    const cleaned = []

    for (const rawLine of lines) {
        const line = rawLine.trim()

        if (!line) {
            continue
        }

        if (
            boilerplatePatterns.some(
                (pattern) =>
                    pattern.test(line)
            )
        ) {
            continue
        }

        const normalized =
            line
                .toLowerCase()
                .replace(/\s+/g, " ")

        // On retire les répétitions exactes
        // typiques des menus/blocs répétés
        if (
            normalized.length > 3 &&
            seen.has(normalized)
        ) {
            continue
        }

        seen.add(normalized)
        cleaned.push(line)
    }

    return cleaned.join("\n")
}

function truncateCleanly(
    text,
    maxChars
) {
    if (text.length <= maxChars) {
        return text
    }

    const chunk =
        text.slice(0, maxChars)

    // On privilégie la fin d'une ligne complète.
    const lastLineBreak =
        chunk.lastIndexOf("\n")

    if (
        lastLineBreak >
        maxChars * 0.8
    ) {
        return chunk
            .slice(0, lastLineBreak)
            .trim()
    }

    // Sinon au minimum, jamais au milieu d'un mot.
    const lastSpace =
        chunk.lastIndexOf(" ")

    if (lastSpace > 0) {
        return chunk
            .slice(0, lastSpace)
            .trim()
    }

    return chunk.trim()
}

function formatPageForPrompt(
    label,
    url,
    markdown,
    maxChars
) {
    const cleaned =
        cleanMarkdown(markdown)

    const truncated =
        truncateCleanly(
            cleaned,
            maxChars
        )

    return `
### ${label}
URL: ${url}

${truncated}
`
}

function tidyTerm(value) {
    if (
        value === null ||
        value === undefined
    ) {
        return ""
    }

    let result = String(value)
        .replace(/\s+/g, " ")
        .trim()

    // Supprime les explications de type :
    // "Yvon Chouinard (Founder)"
    // sans toucher aux noms eux-mêmes.
    result = result.replace(
        /\s+\([^)]{2,120}\)\s*$/,
        ""
    )

    return result.trim()
}

function dedupeKey(value) {
    return value
        .toLowerCase()
        .replace(/[®™©]/g, "")
        .replace(/[.,;:!?'"’“”()]/g, "")
        .replace(/\s+/g, " ")
        .trim()
}

function normalizeBrand(rawBrand) {
    const limits = {
        iconic: 6,
        products: 8,
        people: 4,
        places: 4,
        vocabulary: 12,
        everyday: 10,
        tone: 5,
    }

    const categories = [
        "iconic",
        "products",
        "people",
        "places",
        "vocabulary",
        "everyday",
        "tone",
    ]

    const seen = new Set()

    const result = {
        name:
            tidyTerm(rawBrand.name) ||
            "UNKNOWN",

        iconic: [],
        products: [],
        people: [],
        places: [],
        vocabulary: [],
        everyday: [],
        tone: [],
    }

    for (const category of categories) {
        const values =
            Array.isArray(
                rawBrand[category]
            )
                ? rawBrand[category]
                : []

        for (const rawValue of values) {
            if (
                result[category].length >=
                limits[category]
            ) {
                break
            }

            const value =
    tidyTerm(rawValue)

if (!value) {
    continue
}

const utilityPatterns = [
    /^free shipping$/i,
    /^orders? over/i,
    /^shop$/i,
    /^shop now$/i,
    /^find a store$/i,
    /^learn more$/i,
    /^read more$/i,
    /^buy now$/i,
    /^add to cart$/i,
    /^sign in$/i,
    /^subscribe$/i,
    /^newsletter$/i,
]

if (
    utilityPatterns.some((pattern) =>
        pattern.test(value)
    )
) {
    continue
}

if (
    category === "people" &&
    /^(journalistes?|rédacteur|rédacteurs|editors?|journalists?|staff|team|équipe|employees?)\b/i.test(
        value
    )
) {
    continue
}
            // Filtre quelques rôles génériques
            // qui apparaissaient par exemple
            // dans Le Monde.
            if (
                category === "people" &&
                /^(journalistes?|rédacteur|rédacteurs|editors?|journalists?|staff|team|équipe|employees?)\b/i.test(
                    value
                )
            ) {
                continue
            }

            const key =
                dedupeKey(value)

            if (
                !key ||
                seen.has(key)
            ) {
                continue
            }

            seen.add(key)

            result[category].push(
                value
            )
        }
    }

    return result
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
            maxItems: 6,
            items: {
                type: "string",
            },
        },

        products: {
            type: "array",
            maxItems: 8,
            items: {
                type: "string",
            },
        },

        people: {
            type: "array",
            maxItems: 4,
            items: {
                type: "string",
            },
        },

        places: {
            type: "array",
            maxItems: 4,
            items: {
                type: "string",
            },
        },

        vocabulary: {
            type: "array",
            maxItems: 12,
            items: {
                type: "string",
            },
        },

        everyday: {
            type: "array",
            maxItems: 10,
            items: {
                type: "string",
            },
        },

        tone: {
            type: "array",
            maxItems: 5,
            items: {
                type: "string",
            },
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

const BRAND_PROMPT = `
Build a durable lexical profile for Brand Ipsum from website content.

The output will be injected directly into Lorem Ipsum.
Choose terms that make the generated text recognizably belong to the brand.

Infer internally:
ecommerce | media | saas | other.

PRIORITIZE
- official slogans, taglines, symbols and distinctive brand marks
- signature products and core services
- named people strongly tied to the brand
- meaningful places
- distinctive recurring vocabulary
- concrete objects, materials, actions and interface terms
- lasting communication tone

DURABILITY
Prefer identity likely to remain relevant for years.

EXCLUDE
- temporary promotions and seasonal campaigns
- current news and article subjects
- recently featured products unless they are signature products
- minor or temporary software features
- generic marketing language
- SEO, navigation and legal boilerplate
- unsupported information
- duplicates

TYPE RULES
Ecommerce: favor signature products, materials, craft, heritage and design codes.
Media: favor mission, recurring formats, sections, history and editorial vocabulary. Ignore current events and people merely present in today's news.
SaaS: favor core products, durable features, interface objects and recognizable positioning.

LEXICAL QUALITY

The output is a vocabulary bank for insertion inside Lorem Ipsum.
It is NOT a brand summary.

Choose lexical units that make the text immediately and recognizably belong to this specific brand.

ICONIC
- include only official slogans, taglines, mottos, symbols and established brand nicknames- preserve them exactly and completely as written
- recurring descriptive copy is NOT iconic, even when it appears repeatedly across the website
- words such as "iconic", "signature" or "flagship" describing products do not make the surrounding sentence an iconic brand expression
- official slogans and taglines may be any length
- never shorten, rewrite or split them
- product names NEVER belong in iconic
- do NOT include descriptive marketing sentences, editorial copy or value propositions
- a sentence is iconic only if the brand clearly uses it as an official slogan, tagline, motto or recurring signature expression
- appearing in multiple search snippets does not by itself make a phrase iconic
- when evidence is weak, leave iconic empty rather than filling it with descriptive copy

PRODUCTS
- include only named products, services or collections owned and offered by the brand
- strongly prioritize products explicitly described as signature, iconic, flagship, enduring, permanent or best-selling
- when search evidence explicitly lists "signature products" or equivalent, classify those names under products, NOT iconic
- preserve the complete official product name exactly as found in the evidence
- never invent, translate, shorten or normalize a product name
- if the same product appears in multiple languages, include it only once
- when an official version matching the requested output language appears in the evidence, always prefer that exact localized version
- exclude materials, components, specifications and construction details
- exclude supplier brands and third-party technologies
- exclude certifications and standards
- exclude processes, production methods and business models
- an item used inside a product is not itself a product
- when strong evidence identifies several signature or flagship products, prioritize those and do not fill remaining slots with incidental current products
- fewer highly distinctive products are better than a full list of generic or temporary products
- a product appearing on a scraped product page is not automatically a signature product
- when the requested language is available for signature product names, do not add foreign-language equivalents or unrelated foreign-language products merely to fill the category
- for ecommerce brands, a product mentioned only on the homepage is weak evidence because homepages often reflect the current assortment
- do not include homepage-only products when stronger evidence identifies signature, flagship, iconic, permanent or enduring products
- once strong signature-product evidence exists, only add another product if there is similarly strong evidence that it is durable and brand-distinctive

PEOPLE
- named individuals only
- preserve complete names

PLACES
- named places strongly associated with the brand
- preserve complete place names
- reject generic regions or vague locations

VOCABULARY
- strongly prefer 1 word
- use 2 words only when they form a natural, distinctive lexical unit
- favor proprietary terminology, materials, techniques, recurring concepts and recognizable brand language
- reject sentences, claims and explanations
- reject generic marketing vocabulary
- reject broad abstract values when they could describe many brands
- reject meta-descriptions of the assortment such as "signature products", "iconic pieces", "best sellers" or equivalent category labels
- reject fragments of marketing sentences such as "made to last" unless they are established proprietary expressions
- when output language is requested, avoid foreign-language generic vocabulary if a natural localized equivalent exists

EVERYDAY
- strongly prefer 1 word
- maximum 2 words
- favor concrete objects, materials, actions, interface elements or recurring objects from the brand world
- reject website navigation, ecommerce utilities and calls to action

TONE
- one adjective only
- use tone only to describe communication style
- avoid generic brand virtues

GENERAL
- prefer distinctive over generic
- prefer concrete over abstract
- prefer owned or recognizable language over category vocabulary
- never abbreviate, truncate or invent a term
- preserve the source language
- if evidence is weak, leave the category sparse rather than filling it with generic terms
- each lexical item should belong to the single most appropriate category
- never repeat the same concept across iconic and products

LANGUAGE
- use the requested output language for vocabulary, everyday terms and tone
- generic descriptive terms should be translated into the requested output language
- preserve official slogans, proprietary terminology, people and place names exactly when translation would alter their identity
- product names must NEVER be translated by inference
- when an official localized product name exists in the evidence, use that exact localized version
- if both localized and foreign-language versions of the same product appear, keep only the version matching the requested output language
- avoid mixing languages for generic vocabulary when a natural equivalent exists in the requested language
`

export default async function handler(
    req,
    res
) {
    res.setHeader(
        "Access-Control-Allow-Origin",
        "*"
    )

    res.setHeader(
        "Access-Control-Allow-Methods",
        "POST, OPTIONS"
    )

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
        if (
            !process.env.OPENAI_API_KEY
        ) {
            return res.status(500).json({
                error:
                    "OPENAI_API_KEY is missing",
            })
        }

        if (
            !process.env
                .FIRECRAWL_API_KEY
        ) {
            return res.status(500).json({
                error:
                    "FIRECRAWL_API_KEY is missing",
            })
        }

        const {
    url,
    language: requestedLanguage,
    locale: requestedLocale,
} = req.body || {}

const locale =
    typeof requestedLocale === "string" &&
    requestedLocale.trim()
        ? requestedLocale.trim()
        : "en-US"

const language =
    typeof requestedLanguage === "string" &&
    requestedLanguage.trim()
        ? requestedLanguage
              .trim()
              .toLowerCase()
              .split("-")[0]
        : locale
              .toLowerCase()
              .split("-")[0]

        if (!url) {
            return res.status(400).json({
                error: "URL is required",
            })
        }

        const parsedUrl =
            normalizeUrl(url)

        const hostname =
            normalizeHostname(
                parsedUrl.hostname
            )

        const homepageUrl =
            `${parsedUrl.protocol}//${parsedUrl.host}`

        // V3 = nouveau cache.
        // On ne récupère donc jamais
        // les anciens résultats V2.
        const cacheKey =
    `brand-ipsum:v3-32:${locale.toLowerCase()}:${hostname}`

        // --------------------------------
        // 1. CACHE REDIS
        // --------------------------------

        if (redis) {
            try {
                const cached =
                    await redis.get(
                        cacheKey
                    )

                if (cached) {
                    const cachedBrand =
                        cached.brand ||
                        cached

                    return res
                        .status(200)
                        .json({
                            brand:
                                cachedBrand,

                            meta: {
    source:
        "cache",

    hostname,
    language,
    locale,

    version:
        "v3",

    pagesUsed:
        cached.pagesUsed ||
        [],
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

        // --------------------------------
        // 2. HOMEPAGE
        // --------------------------------

        const homepage =
            await scrapePage(
                homepageUrl,
                true
            )

        if (!homepage.markdown) {
            throw new Error(
                "No usable homepage content found"
            )
        }
const siteType =
    inferSiteType(
        homepage.markdown,
        homepage.links
    )
        
        // --------------------------------
        // 3. CHOIX DES PAGES EVERGREEN
        // --------------------------------

let discoverySource =
    "homepage+search"

let mappedLinksCount = 0
let searchPreview = []
let searchResults = []

// La homepage reste une source
// de candidats, mais Search complète
// systématiquement la discovery.
try {
    searchResults =
    await searchEvergreenPages(
        hostname,
        language,
        locale,
        siteType
    )

    mappedLinksCount =
        searchResults.length

    searchPreview =
        searchResults
            .slice(0, 10)
            .map((item) => ({
                title:
                    item.title || "",
                url:
                    item.url || "",
                description:
                    truncateCleanly(
                        item.description || "",
                        600
                    ),
            }))
} catch (error) {
    discoverySource =
        "homepage+search-error"

    console.error(
        "Firecrawl search failed:",
        error
    )
}

// Les liens de homepage et les résultats
// Search sont maintenant évalués ensemble.
let extraUrls =
    selectEvergreenPages(
        [
            ...homepage.links,
            ...searchResults,
        ],
        hostname,
        homepageUrl,
        language
    )

        // --------------------------------
        // 4. SCRAPE MAX 2 PAGES
        // --------------------------------

        const extraPages =
            await Promise.all(
                extraUrls.map(
                    async (pageUrl) => {
                        try {
                            const page =
                                await scrapePage(
                                    pageUrl
                                )

                            if (
                                !page.markdown
                            ) {
                                return null
                            }

                            return {
                                url: pageUrl,

                                markdown:
                                    page.markdown,
                            }
                        } catch (error) {
                            console.error(
                                `Extra page failed: ${pageUrl}`,
                                error
                            )

                            return null
                        }
                    }
                )
            )

        const usableExtraPages =
            extraPages.filter(Boolean)

        // --------------------------------
        // 5. CONTEXTE COURT
        // --------------------------------

        let websiteContext =
            formatPageForPrompt(
                "Homepage",
                homepageUrl,
                homepage.markdown,
                MAX_HOME_CHARS
            )

        let productEvidence = ""

        usableExtraPages.forEach(
            (page, index) => {
                const pageIsProductEvidence =
    isProductEvidenceUrl(
        page.url,
        siteType
    )

                const formattedPage =
                    formatPageForPrompt(
                        pageIsProductEvidence
                            ? `Product evidence page ${index + 1}`
                            : `Evergreen page ${index + 1}`,
                        page.url,
                        page.markdown,
                        MAX_EXTRA_PAGE_CHARS
                    )

                if (
                    pageIsProductEvidence
                ) {
                    productEvidence +=
                        formattedPage
                } else {
                    websiteContext +=
                        formattedPage
                }
            }
        )

const productSearchEvidence =
    searchPreview
        .filter((item) => {
            const url =
                item.url || ""

            if (
                url.includes("-stock") ||
                url.includes("/stock/")
            ) {
                return false
            }

            return isProductEvidenceUrl(
                url,
                siteType
            )
        })
        .slice(0, 10)

        if (
            productSearchEvidence.length > 0
        ) {
            productEvidence += `
### SEARCH PRODUCT EVIDENCE

The following search snippets are secondary product evidence.
Use them only to identify products, services or collections that
are explicitly presented as signature, flagship, iconic,
enduring, permanent or best-selling.

Do not treat an article title or a temporary product mention as
a durable product merely because it appears in search results.

${productSearchEvidence
    .map(
        (item, index) => `
[${index + 1}]
TITLE: ${item.title}
URL: ${item.url}
SNIPPET: ${item.description}
`
    )
    .join("\n")}
`
        }

        if (!productEvidence.trim()) {
            productEvidence =
                "No strong product evidence was found."
        }

        // --------------------------------
        // 6. UN SEUL APPEL OPENAI
        // --------------------------------

        const response =
            await client.responses.create({
                model:
                    "gpt-4.1-mini",

                // Aide le prompt caching
                // à router ensemble les
                // requêtes ayant le même
                // préfixe stable.
                prompt_cache_key:
                    "brand-ipsum-v3",

                input: [
                    {
                        role: "system",
                        content:
                            BRAND_PROMPT,
                    },

                    {
                        role: "user",
                        content: `
DOMAIN:
${hostname}

OUTPUT LANGUAGE:
${language}

OUTPUT LOCALE:
${locale}

GENERAL WEBSITE CONTEXT:
${websiteContext}

PRODUCT EVIDENCE:
${productEvidence}

SOURCE RULES:
- The products array MUST use PRODUCT EVIDENCE as its exclusive source.
- Never add a product solely because it appears in GENERAL WEBSITE CONTEXT or on the homepage.
- If PRODUCT EVIDENCE supports only one or two durable products, return only those.
- Other categories may use both GENERAL WEBSITE CONTEXT and PRODUCT EVIDENCE.
`,
                    },
                ],

                text: {
                    format: {
                        type: "json_schema",

                        name:
                            "brand_profile",

                        strict: true,

                        schema:
                            brandSchema,
                    },
                },
            })

        const rawBrand =
            JSON.parse(
                response.output_text
            )

        // --------------------------------
        // 7. NETTOYAGE FINAL
        // --------------------------------

        const brand =
            normalizeBrand(rawBrand)

        const pagesUsed = [
            homepageUrl,

            ...usableExtraPages.map(
                (page) => page.url
            ),
        ]

        // --------------------------------
        // 8. CACHE 7 JOURS
        // --------------------------------

        if (redis) {
            try {
                await redis.set(
                    cacheKey,
                    {
                        brand,
                        pagesUsed,
                    },
                    {
                        ex:
                            CACHE_TTL_SECONDS,
                    }
                )
            } catch (error) {
                console.error(
                    "Redis write failed:",
                    error
                )
            }
        }

        // --------------------------------
        // 9. REPONSE
        // --------------------------------

        return res.status(200).json({
    brand,

    meta: {
    source: "fresh",
    version: "v3",
    hostname,
    language,
    locale,
    pagesUsed,

        discovery: {
            source: discoverySource,
            homepageLinks:
                homepage.links.length,
            mappedLinks:
                mappedLinksCount,
            selectedPages:
                extraUrls,
            searchPreview,
        },

        contextChars:
            websiteContext.length,

        usage: {
            inputTokens:
                response.usage
                    ?.input_tokens ??
                null,

            cachedTokens:
                response.usage
                    ?.input_tokens_details
                    ?.cached_tokens ??
                0,

            outputTokens:
                response.usage
                    ?.output_tokens ??
                null,
        },
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
