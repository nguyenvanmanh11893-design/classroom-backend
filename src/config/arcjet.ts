import arcjet, { detectBot, shield, slidingWindow } from "@arcjet/node";

if (!process.env.ARCJET_KEY && process.env.ARCJET_ENV!=='test') {
  throw new Error("ARCJET_KEY environment variable is required")
}

const aj = arcjet({
  key: process.env.ARCJET_KEY!,
  rules: [

    shield({ mode: "LIVE" }),
    detectBot({
      mode: "LIVE",
      allow: [
        "CATEGORY:SEARCH_ENGINE", 
        "CATEGORY:PREVIEW", // Link previews e.g. Slack, Discord
      ],
    }),
    slidingWindow({
      mode: 'LIVE',
      interval: '2s', // 2 seconds
      max: 5, // Max 5 requests per window
    })
  ],
})

export default aj