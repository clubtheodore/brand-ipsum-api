import OpenAI from "openai"

const client = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
})


export default async function handler(req, res) {

    if (req.method !== "POST") {
        return res.status(405).json({
            error: "Method not allowed"
        })
    }


    const { url } = req.body


    const response = await client.responses.create({
        model: "gpt-4.1-mini",
        input: `
Analyse cette marque à partir de son URL :

${url}

Retourne uniquement un JSON avec cette structure :

{
  "name": "",
  "iconic": [],
  "products": [],
  "people": [],
  "vocabulary": [],
  "everyday": [],
  "tone": []
}
        `,
    })


    return res.status(200).json({
        brand: JSON.parse(response.output_text)
    })
}
