import OpenAI from "openai"

export default async function handler(req, res) {
    // Autorise les appels depuis Framer / navigateur
    res.setHeader("Access-Control-Allow-Origin", "*")
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS")
    res.setHeader("Access-Control-Allow-Headers", "Content-Type")

    // Réponse au pré-check du navigateur
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

        const { url } = req.body || {}

        if (!url) {
            return res.status(400).json({
                error: "URL is required",
            })
        }

        const client = new OpenAI({
            apiKey: process.env.OPENAI_API_KEY,
        })

        const response = await client.responses.create({
            model: "gpt-4.1-mini",
            input: `
Analyze the brand associated with this URL:

${url}

Return only valid JSON with this structure:

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
            .replace(/```json/g, "")
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
