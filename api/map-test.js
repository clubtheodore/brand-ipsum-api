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
        "GET, OPTIONS"
    )

    res.setHeader(
        "Access-Control-Allow-Headers",
        "Content-Type"
    )

    if (req.method === "OPTIONS") {
        return res.status(200).end()
    }

    if (req.method !== "GET") {
        return res.status(405).json({
            error: "Method not allowed",
        })
    }

    if (
        !process.env.FIRECRAWL_API_KEY
    ) {
        return res.status(500).json({
            error:
                "FIRECRAWL_API_KEY is missing",
        })
    }

    try {
        const response = await fetch(
            "https://api.firecrawl.dev/v2/map",
            {
                method: "POST",

                headers: {
                    Authorization:
                        `Bearer ${process.env.FIRECRAWL_API_KEY}`,
                    "Content-Type":
                        "application/json",
                },

                body: JSON.stringify({
                    url:
                        "https://stripe.com",
                    sitemap: "include",
                    includeSubdomains:
                        false,
                    ignoreQueryParameters:
                        true,
                    limit: 100,
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
            return res.status(500).json({
                error:
                    "Firecrawl returned invalid JSON",
                status:
                    response.status,
                raw:
                    rawText.slice(
                        0,
                        1000
                    ),
            })
        }

        return res
            .status(response.status)
            .json(data)
    } catch (error) {
        return res.status(500).json({
            error:
                error instanceof Error
                    ? error.message
                    : "Unknown error",
        })
    }
}
