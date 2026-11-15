// "Mission Control" chatbot: natural-language front end for buildVerdict().
// Flow: user message -> Gemini extracts {o2_fraction, pressure_atm, material}
//       -> buildVerdict() hits Tiger Data -> Gemini turns that JSON into a plain-English answer.
// Two models: Grok (xAI, the default) or Gemini (through Cloudflare AI Gateway). The caller picks with "model".
import type { Sql } from 'postgres';
import { buildVerdict } from './index';

export type ChatModel = 'grok' | 'gemini';
export const CHAT_MODELS: ChatModel[] = ['grok', 'gemini'];

export interface ChatEnv {
  XAI_API_KEY?: string;
  GEMINI_API_KEY: string;
  AI_GATEWAY_ACCOUNT_ID: string;
  AI_GATEWAY_ID: string;
  CF_AIG_TOKEN?: string;
}

function geminiUrl(env: ChatEnv, model = 'gemini-2.5-flash') {
  // Cloudflare AI Gateway universal endpoint for Google AI Studio.
  return `https://gateway.ai.cloudflare.com/v1/${env.AI_GATEWAY_ACCOUNT_ID}/${env.AI_GATEWAY_ID}/google-ai-studio/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`;
}

async function callGemini(env: ChatEnv, systemPrompt: string, userText: string, jsonMode: boolean) {
  const res = await fetch(geminiUrl(env), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-goog-api-key': env.GEMINI_API_KEY,
      ...(env.CF_AIG_TOKEN ? { 'cf-aig-authorization': `Bearer ${env.CF_AIG_TOKEN}` } : {}),
    },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: 'user', parts: [{ text: userText }] }],
      generationConfig: jsonMode ? { response_mime_type: 'application/json' } : undefined,
    }),
  });
  if (!res.ok) throw new Error(`Gemini error ${res.status}: ${await res.text()}`);
  const data: any = await res.json();
  return data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
}

const GROK_MODEL = 'grok-4.20-non-reasoning';

async function callGrok(env: ChatEnv, systemPrompt: string, userText: string, jsonMode: boolean) {
  if (!env.XAI_API_KEY) throw new Error('Grok is not configured (XAI_API_KEY missing)');
  const res = await fetch('https://api.x.ai/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${env.XAI_API_KEY}` },
    body: JSON.stringify({
      model: GROK_MODEL,
      messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userText }],
      ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
    }),
  });
  if (!res.ok) throw new Error(`Grok error ${res.status}: ${await res.text()}`);
  const data: any = await res.json();
  return data?.choices?.[0]?.message?.content ?? '';
}

const callModel = (model: ChatModel, env: ChatEnv, systemPrompt: string, userText: string, jsonMode: boolean) =>
  model === 'gemini' ? callGemini(env, systemPrompt, userText, jsonMode) : callGrok(env, systemPrompt, userText, jsonMode);

const EXTRACT_PROMPT = `Classify the user's fire-science question and extract test conditions when needed.
Return ONLY JSON: {"kind": "lookup"|"general", "o2_fraction": number|null, "pressure_atm": number|null, "material": string|null}.
kind is "lookup" only when the user asks what the dataset indicates about a named material or fuel under an atmosphere.
Use "general" for broader fire science, spacecraft fire safety, microgravity combustion, NASA mission or experiment
questions, data and methods questions, follow-ups, and greetings. Do not force a general science question into a material
lookup just because it mentions oxygen, pressure, or fire.
o2_fraction is 0-1 (30% -> 0.30). pressure_atm is 0-5 (1 atm is normal cabin pressure).
If a number isn't mentioned, use null. Never guess a number that wasn't stated or clearly implied. Numbers given as the
atmosphere on the page count as stated. For lookup, use those page values when the user says "here", "this atmosphere",
or otherwise clearly refers to the selected scenario.`;

const GENERAL_PROMPT = `You are Mission Control, a helpful fire-science guide focused on spacecraft fire safety, combustion in
microgravity, and NASA's fire and combustion research. You are given the user's question and a JSON overview of NASA's
Physical Sciences Informatics (PSI) dataset: totals, frequently tested fuel names, investigations, and recorded outcomes.
Answer the user's actual question in 2-5 concise sentences of plain text, without markdown or bullets. You may explain
well-established general fire science even when it is not covered by the overview. Clearly distinguish general scientific
explanations from findings in NASA's dataset; never imply that a NASA experiment measured something unless it appears in
the supplied overview. For dataset counts, use only numbers present in the JSON and explain what they count. Name
investigations by title and id. Mention the atmosphere on the page only when relevant. If the question is outside fire
science, spacecraft fire safety, combustion, or this dataset, briefly say what you can help with instead. Do not present
historical test outcomes as proof that a material is safe, certified, or approved, and do not give instructions for
handling an active fire or hazardous materials.`;

async function overview(sql: Sql) {
  const [totals] = await sql`
    SELECT count(*)::int AS tests_total,
           count(*) FILTER (WHERE o2_fraction IS NOT NULL)::int AS tests_with_oxygen_recorded,
           count(*) FILTER (WHERE o2_fraction IS NOT NULL AND pressure_atm IS NOT NULL)::int AS tests_with_oxygen_and_pressure_recorded,
           count(DISTINCT lower(trim(fuel_material))) FILTER (WHERE coalesce(trim(fuel_material), '') <> '')::int AS distinct_fuel_names,
           count(DISTINCT investigation_id)::int AS investigations_with_tests
      FROM experimental_tests`;
  const fuels = await sql`
    SELECT fuel_material AS fuel, count(*)::int AS tests,
           count(*) FILTER (WHERE o2_fraction IS NOT NULL AND pressure_atm IS NOT NULL)::int AS with_oxygen_and_pressure
      FROM experimental_tests WHERE coalesce(trim(fuel_material), '') <> ''
     GROUP BY fuel_material ORDER BY count(*) DESC LIMIT 30`;
  const investigations = await sql`
    SELECT t.investigation_id AS id, max(i.title) AS title, count(*)::int AS tests
      FROM experimental_tests t LEFT JOIN investigations i ON i.accession = t.investigation_id
     GROUP BY t.investigation_id ORDER BY count(*) DESC`;
  const outcomes = await sql`
    SELECT coalesce(nullif(trim(outcome), ''), 'not recorded') AS outcome, count(*)::int AS tests
      FROM experimental_tests GROUP BY 1 ORDER BY 2 DESC LIMIT 15`;
  return { totals, top_fuels: fuels, investigations, outcomes };
}

async function answerGeneral(sql: Sql, env: ChatEnv, model: ChatModel, message: string) {
  const data = await overview(sql);
  const reply = await callModel(model, env, GENERAL_PROMPT, `Question and conversation:
${message}

Database overview JSON:
${JSON.stringify(data)}`, false);
  return { model, reply, verdict: null, overview: data.totals };
}

const ANSWER_PROMPT = `You are Mission Control, a fire-safety assistant for spacecraft combustion questions.
You are given JSON evidence pulled from real NASA PSI combustion test data. Answer in 3-5 sentences,
spoken aloud or read as plain text — no markdown, bullets, or symbols:
1. Open with how the flames ended in the nearest tested conditions (most went out, mixed, or most kept
   burning), only if "quantified" is true and relation/evidence supports it; otherwise say clearly there's
   no direct quantified match. Every test was ignited on purpose, so never call a material safe, certified
   or approved, and never use the words PASS, CAUTION or FAIL.
2. Give the "why" — restate the actual O2%/pressure tested, how many tests back it up, and whether this
   is an exact match, interpolation, or extrapolation from the tested range (explain what that means in
   plain words, don't just name it).
3. Name the investigation (id and title) and its DOI you're citing, and mention burn rate or
   extinction/disruption counts if present.
4. If "quantified" is false, summarize what the closest matching research actually found instead of just
   saying there's no data.
5. If the evidence has "verified": false, say plainly that this is community-contributed data, not
   reviewed NASA PSI data, and weigh the verdict accordingly — don't give it the same confidence as
   verified evidence.
Never invent numbers not present in the JSON. Never pad with disclaimers beyond what the data supports.`;

// Ask the chosen model; if it fails (quota, outage, missing key), ask the other one once and say so in the reply.
export async function handleChat(sql: Sql, env: ChatEnv, message: string, model: ChatModel = 'grok') {
  try {
    return await runChat(sql, env, message, model);
  } catch (first) {
    const other: ChatModel = model === 'grok' ? 'gemini' : 'grok';
    try {
      const r = await runChat(sql, env, message, other);
      return { ...r, requested_model: model, fallback_reason: String((first as Error).message).slice(0, 200) };
    } catch {
      throw first;
    }
  }
}

async function runChat(sql: Sql, env: ChatEnv, message: string, model: ChatModel) {
  const extractedRaw = await callModel(model, env, EXTRACT_PROMPT, message, true);
  let extracted: { kind?: 'lookup' | 'general'; o2_fraction: number | null; pressure_atm: number | null; material: string | null };
  try {
    extracted = JSON.parse(extractedRaw);
  } catch {
    return { model, reply: "I couldn't pull O2%/pressure/material out of that — try something like 'is heptane safe at 30% O2 and 0.7 atm?'", verdict: null };
  }

  // Anything that is not a material-in-an-atmosphere lookup is answered from an overview of the whole table.
  if (extracted.kind === 'general') return answerGeneral(sql, env, model, message);
  if (extracted.o2_fraction == null || extracted.pressure_atm == null) {
    return {
      model,
      reply: 'I need both an oxygen fraction and a pressure to look this up — e.g. "30% O2 at 0.7 atm, PMMA".',
      verdict: null,
      extracted,
    };
  }

  const verdict = await buildVerdict(sql, {
    o2: extracted.o2_fraction,
    p: extracted.pressure_atm,
    material: extracted.material ?? '',
  });

  const reply = await callModel(model, env, ANSWER_PROMPT, JSON.stringify(verdict), false);
  return { model, reply, verdict, extracted };
}
