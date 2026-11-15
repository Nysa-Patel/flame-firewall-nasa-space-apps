# Phenox Twilio agent

SMS/voice front end for the Phenox mission control chatbot. This is just a
bridge: it takes what the caller/texter says, forwards it to the deployed
`/chat` endpoint on the Cloudflare Worker (which does the Gemini + Tiger Data
work), and sends the reply back over SMS or voice.

## Setup

```bash
npm install
```

Run the Twilio setup wizard to create a Memory Store + Conversation
Configuration and fill most of `.env` for you:

```bash
npx twilio-agent-connect setup   # opens http://localhost:8080
```

Copy `.env.example` to `.env`, fill in whatever the wizard didn't, and set
`FIRELINE_WORKER_URL` to Person B's deployed worker URL if it's not the
default below.

## Run

```bash
npm start
```

Then point your Twilio phone number's SMS/Voice webhook at this server
(use `ngrok http <port>` to expose it locally for the demo), or use the
Twilio Dev Phone to test without a real number.

## Test without Twilio at all

The worker endpoint this calls works standalone:

```bash
curl -s -X POST https://fireline-verdict.fireline-team.workers.dev/chat \
  -H "content-type: application/json" \
  -d '{"message":"is heptane safe at 30% O2 and 0.7 atm?"}'
```

If that curl works, the agent will work once Twilio is wired up — the
agent code never talks to Gemini or the database directly.
