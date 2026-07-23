import OpenAI from "openai"

export default async function handler(req, res) {
    res.setHeader("Access-Control-Allow-Origin", "*")
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS")
    res.setHeader("Access-Control-Allow-Headers", "Content-Type")

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

        // 1. Scrape la page avec Firecrawl
        const firecrawlResponse = await fetch(
            "https://api.firecrawl.dev/v2/scrape",
            {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${process.env.FIRECRAWL_API_KEY}`,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    url,
                    formats: ["markdown"],
                    onlyMainContent: true,
                    removeBase64Images: true,
                    blockAds: true,
                }),
            }
        )

        const firecrawlData = await firecrawlResponse.json()

        if (!firecrawlResponse.ok || !firecrawlData.success) {
            throw new Error(
                firecrawlData.error || "Firecrawl scrape failed"
            )
        }

        const markdown = firecrawlData.data?.markdown || ""

        if (!markdown) {
            throw new Error("Firecrawl returned no page content")
        }

        // On limite volontairement la quantité de texte envoyée à OpenAI
        const pageContent = markdown.slice(0, 18000)

        // 2. Analyse le vrai contenu de la page
        const client = new OpenAI({
            apiKey: process.env.OPENAI_API_KEY,
        })

        const response = await client.responses.create({
            model: "gpt-4.1-mini",
            input: `
You are analyzing a brand website to create a playful branded Lorem Ipsum generator.

Website URL:
${url}

Website content:
---
${pageContent}
---

Identify the brand from the actual website content.

Favor concrete, recognizable brand references over generic marketing adjectives:
- iconic slogans, symbols or concepts
- actual products or services
- important people
- places associated with the brand
- distinctive vocabulary
- everyday concrete words connected to the brand
- tone descriptors

Do not invent facts that are not reasonably supported by the website content.

For French brands or predominantly French content, keep the vocabulary in French.

Return ONLY valid JSON with exactly this structure:

{
  "name": "",
  "iconic": [],
  "products": [],
  "people": [],
  "places": [],
  "vocabulary": [],
  "everyday": [],
  "tone": []
}
`,
        })

        const raw = response.output_text
            .replace(/```json/gi, "")
            .replace(/```/g, "")
            .trim()

        const brand = JSON.parse(raw)

        return res.status(200).json({
            brand,
        })
    } catch (error) {
        console.error("Brand Ipsum API error:", error)

        return res.status(500).json({
            error:
                error instanceof Error
                    ? error.message
                    : "Unknown server error",
        })
    }
}
