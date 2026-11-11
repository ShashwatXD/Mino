import type { Trace } from "../src/domain/trace.ts";

/** Past chats the cases ask about, dated in the user's zone (Asia/Kolkata). */
export const FIXTURES = [
  {
    threadId: "pg",
    at: [2026, 11, 3, 10, 15],
    question: "Compare Neon, Supabase and AWS RDS for hosting Postgres for a small SaaS. Include current prices.",
    answer: "| Provider | Plan | Price |\n|---|---|---|\n| Neon | Launch | $19/month, usage-based compute |\n| Supabase | Pro | $25/month per project |\n| AWS RDS | db.t4g.micro | about $12/month plus storage |",
  },
  {
    threadId: "pizza",
    at: [2026, 11, 3, 18, 40],
    question: "Neapolitan pizza dough recipe for a home oven",
    answer: "500 g 00 flour, 325 g water (65%), 10 g salt, 2 g dry yeast. Rest 24 hours cold.",
  },
  {
    threadId: "goa",
    at: [2026, 11, 7, 21, 5],
    question: "Plan a 4-day Goa trip in December for two, budget ₹40,000",
    answer: "Budget split for ₹40,000:\n- Stay: ₹16,000\n- Travel: ₹12,000\n- Food: ₹7,000\n- Activities: ₹5,000",
  },
  {
    threadId: "crm",
    at: [2026, 11, 9, 11, 30],
    question: "We are a 20-person sales team. Shortlist 5 CRM tools with pricing.",
    answer: "1. HubSpot Sales Hub Professional: $90/seat\n2. Pipedrive Growth: $49/seat\n3. Salesforce Sales Cloud Enterprise: $175/seat\n4. Zoho CRM Professional: $40/seat\n5. Freshsales Pro: $47/seat",
  },
] as const;

export interface Result {
  text: string;
  trace: Trace;
}

type Check = [label: string, passes: (r: Result) => boolean];

const says = (pattern: RegExp): ((r: Result) => boolean) => (r) => pattern.test(r.text);
const lookedUp = (day: string) => (r: Result) =>
  r.trace.spans.some((s) => s.name === "search_history" && typeof s.attributes.from === "string" && s.attributes.from <= day && String(s.attributes.to ?? s.attributes.from) >= day);
const nov = (day: number) => new RegExp(`\\b${day}(st|nd|rd|th)? Nov|Nov(ember)? ${day}\\b`, "i");

export interface Case {
  id: string;
  thread: string;
  message: string;
  /** Sent first, in another chat, when the case depends on something stated earlier. */
  setup?: { thread: string; message: string };
  checks: Check[];
}

export const CASES: Case[] = [
  {
    id: "brief: Postgres last Tuesday",
    thread: "e1",
    message: "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?",
    checks: [
      ["looks up 3 November", lookedUp("2026-11-03")],
      ["quotes the earlier prices", says(/\$19|\$25/)],
      ["gives the earlier date", says(nov(3))],
      ["checks the web", (r) => r.trace.webSearches > 0],
    ],
  },
  {
    id: "brief: CRM shortlist on Monday",
    thread: "e2",
    message: "On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?",
    checks: [
      ["looks up 9 November", lookedUp("2026-11-09")],
      ["names all five tools", (r) => ["HubSpot", "Pipedrive", "Salesforce", "Zoho", "Freshsales"].every((n) => r.text.includes(n))],
      ["checks the web", (r) => r.trace.webSearches > 0],
    ],
  },
  {
    id: "brief: what was asked on 3 November",
    thread: "e3",
    message: "What did I ask you on 3 November? Is your answer still correct today?",
    checks: [
      ["looks up 3 November", lookedUp("2026-11-03")],
      ["finds the Postgres chat", says(/postgres|neon|supabase/i)],
      ["finds the pizza chat", says(/pizza/i)],
    ],
  },
  {
    id: "no record for that day",
    thread: "e4",
    message: "Last Friday I asked you about Kubernetes ingress controllers. What did you recommend?",
    checks: [
      ["searches history", (r) => r.trace.historyCalls > 0],
      ["says there is no record", says(/no record|don't have|do not have|couldn't find|can't find|could not find|no (past )?(conversation|chat)/i)],
      ["claims no earlier recommendation", (r) => !/I recommended|I suggested/i.test(r.text)],
    ],
  },
  {
    id: "wrong day remembered",
    thread: "e5",
    message: "Yesterday I asked you to plan a Goa trip. What was the budget split?",
    checks: [
      ["gives the real date, 7 November", says(nov(7))],
      ["quotes the split", says(/16,000/)],
    ],
  },
  {
    id: "misspelled topic",
    thread: "e6",
    message: "what did i tell you about postgress hostng?",
    checks: [["finds the Postgres chat", says(/Neon/)]],
  },
  {
    id: "exact figure",
    thread: "e7",
    message: "What exact price did you quote me for Supabase Pro?",
    checks: [
      ["quotes $25", says(/\$25/)],
      ["gives its date", says(nov(3))],
    ],
  },
  {
    id: "web only, no history",
    thread: "e8",
    message: "What is the latest stable version of Node.js right now?",
    checks: [
      ["does not search history", (r) => r.trace.historyCalls === 0],
      ["checks the web", (r) => r.trace.webSearches > 0],
    ],
  },
  {
    id: "no tools needed",
    thread: "e9",
    message: "Explain MVCC in two sentences.",
    checks: [
      ["does not search history", (r) => r.trace.historyCalls === 0],
      ["stays short", (r) => r.text.length < 900],
    ],
  },
  {
    id: "fact from another chat",
    thread: "f2",
    setup: { thread: "f1", message: "My name is Riya and I live in Pune." },
    message: "Suggest one weekend getaway near where I live.",
    checks: [["uses the stated city", says(/Pune|Lonavala|Mahabaleshwar|Lavasa|Alibaug|Kamshet|Panchgani/i)]],
  },
];
