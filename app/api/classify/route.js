import { NextResponse } from "next/server";
import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Classify a news item against task definitions
async function classifyNews(newsItem, taskDefs, companyName) {
  const taskList = taskDefs
    .map(
      (t) =>
        `ID:${t.id} | "${t.name}" | Keywords: ${(t.keywords || []).join(", ")} | Sources: ${(t.sources || []).join(", ")}${t.scoringPrompt ? "\nScoring Criteria: " + t.scoringPrompt.slice(0, 300) : ""}`
    )
    .join("\n\n");

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4.1",
      temperature: 0.1,
      max_tokens: 600,
      messages: [
        {
          role: "system",
          content: `You are a STRICT B2B signal classification engine. Given a news headline about a company and task definitions with scoring criteria, determine which tasks (if any) this news item triggers.

CRITICAL RULES — apply these before matching:
1. The signal must match the SPECIFIC event type described in the task, not just share keywords
2. The person/subject in the news must match the role type the task tracks (e.g. a "robotics leader" is NOT a "senior marketer")
3. If the task says "new non-traditional entrants" — the company in the headline must BE the new entrant threatening incumbents, not an incumbent doing something new
4. If the task tracks exits/departures — the person must hold the specific role type mentioned (CMO ≠ engineering lead)
5. General company news that happens to contain a keyword is NOT a match
6. When in doubt, DO NOT MATCH. False negatives are far better than false positives.
7. Use each task's Scoring Criteria to judge fit — if the signal would score below 60 per those criteria, do NOT include it.

Return ONLY a JSON object: {"matchedTaskIds": ["id1"], "confidence": 0.0-1.0, "reasoning": "brief explanation"}
If no tasks match (WHICH IS OFTEN THE CORRECT ANSWER), return: {"matchedTaskIds": [], "confidence": 0, "reasoning": "No relevant signal"}`,
        },
        {
          role: "user",
          content: `Company: ${companyName}\nHeadline: "${newsItem.headline}"\nDescription: "${newsItem.description || ""}"\n\nTask Definitions:\n${taskList}`,
        },
      ],
    });

    const text = completion.choices[0]?.message?.content || "{}";
    const cleaned = text.replace(/```json\n?|```/g, "").trim();
    return JSON.parse(cleaned);
  } catch (e) {
    console.error("Classification error:", e);
    return { matchedTaskIds: [], confidence: 0, reasoning: "Classification failed" };
  }
}

// Refine a vague task description into a structured task definition
async function refineTask(userInput) {
  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4.1",
      temperature: 0.5,
      max_tokens: 1000,
      messages: [
        {
          role: "system",
          content: `You are an expert B2B sales signal architect. Given a rough description of a business signal, produce a structured task definition for an AI signal detection system. Return ONLY a JSON object with:
{
  "name": "Concise task name (max 60 chars)",
  "description": "2-3 sentence explanation of what this signal means and why it matters for sales outreach",
  "ease": "Easy|Medium|Hard" (how easy is this to detect from public sources),
  "strength": "Strong|Medium|Weak" (how strongly this correlates with buying intent),
  "taskType": "news|job_post|both" (news = track via news articles, job_post = track via LinkedIn job listings, both = track on both),
  "sources": ["News", "Job Posts", "New Hires", "Social", "Exits / Promotions", "Custom", "Earnings", "SEC Filings"] (pick relevant ones),
  "keywords": ["keyword1", "keyword2", ...] (5-8 specific keywords for news matching),
  "jobTitleKeywords": ["Job Title 1", "Job Title 2", ...] (5-8 LinkedIn job title search terms — ONLY include if taskType is "job_post" or "both", otherwise empty array)
}

IMPORTANT: If the signal is about hiring, job openings, or specific roles being created → set taskType to "job_post" or "both" and include jobTitleKeywords. If it's about market events, news, leadership announcements → set taskType to "news". If it could be detected through both channels → set taskType to "both".`,
        },
        {
          role: "user",
          content: userInput,
        },
      ],
    });

    const text = completion.choices[0]?.message?.content || "{}";
    const cleaned = text.replace(/```json\n?|```/g, "").trim();
    return { success: true, task: JSON.parse(cleaned) };
  } catch (e) {
    console.error("Task refinement error:", e);
    return { success: false, error: "Failed to refine task" };
  }
}

// Generate AI insights for a specific task
async function generateInsights(task, companyName) {
  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4.1",
      temperature: 0.6,
      max_tokens: 600,
      messages: [
        {
          role: "system",
          content: `You are a B2B sales intelligence analyst. Given a detected signal task and company, provide actionable insights. Return ONLY a JSON object:
{
  "insights": [{"icon": "emoji", "text": "insight text"}],
  "suggestedActions": ["action 1", "action 2", "action 3"],
  "urgency": "Critical|High|Moderate|Low",
  "talkingPoints": ["point 1", "point 2"]
}`,
        },
        {
          role: "user",
          content: `Company: ${companyName}\nSignal: "${task.taskName}"\nDescription: ${task.taskDescription || task.taskName}\nScore: ${task.score}/10\nEase: ${task.ease}\nStrength: ${task.strength}\nTriggering headline: "${task.newsHeadline || "N/A"}"\n${task.articleContent ? `Article content: ${task.articleContent.slice(0, 600)}` : ""}`,
        },
      ],
    });

    const text = completion.choices[0]?.message?.content || "{}";
    const cleaned = text.replace(/```json\n?|```/g, "").trim();
    return { success: true, data: JSON.parse(cleaned) };
  } catch (e) {
    console.error("Insights error:", e);
    return { success: false, error: "Failed to generate insights" };
  }
}

// Generate optimal LinkedIn search keywords for a job task
async function generateJobKeywords(taskName, taskDescription) {
  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4.1",
      temperature: 0.3,
      max_tokens: 400,
      messages: [
        {
          role: "system",
          content: `You are a LinkedIn job search expert. Given a signal task description, generate the most effective job title keywords for LinkedIn search. 

RULES:
1. Return 5-10 exact job titles that someone would search on LinkedIn to find this type of role.
2. Focus on TITLES that appear in actual LinkedIn job listings — not generic descriptions.
3. Include variations: full title ("Chief Marketing Officer"), abbreviation ("CMO"), and common alternatives ("VP Marketing").
4. Think about seniority variations: Director, VP, SVP, Head of, Global Head of.
5. Return ONLY a JSON object: {"keywords": ["CMO", "Chief Marketing Officer", "VP Marketing", ...]}
6. No markdown, no backticks.`,
        },
        {
          role: "user",
          content: `Task: "${taskName}"\nDescription: ${taskDescription || taskName}`,
        },
      ],
    });

    const text = completion.choices[0]?.message?.content || "{}";
    const cleaned = text.replace(/```json\n?|```/g, "").trim();
    const data = JSON.parse(cleaned);
    return { keywords: data.keywords || [] };
  } catch (e) {
    console.error("Job keyword generation error:", e);
    // Fallback: extract potential keywords from task name
    const words = (taskName || "").split(/[\s\/,]+/).filter(w => w.length > 2);
    return { keywords: words.slice(0, 5) };
  }
}

async function generateScoringPrompt(taskName, taskDescription, taskKeywords, taskSources, taskJobTitleKeywords) {
  const isJobPost = (taskSources || []).some(s => s === "Job Posts");
  const isNews = (taskSources || []).some(s => ["News","New Hires","Social","Exits / Promotions","Custom","Earnings","SEC Filings"].includes(s));
  const sourceType = isJobPost && isNews ? "news articles AND job postings" : isJobPost ? "job postings" : "news articles";

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4.1",
      temperature: 0.25,
      max_tokens: 1500,
      messages: [
        {
          role: "system",
          content: `You generate scoring criteria prompts for a B2B signal intelligence tool. Given a task definition, create a STRICT, precise scoring prompt that an AI will use to rate the relevance of ${sourceType} from 0-100.

Your prompt MUST include ALL of these sections in this order:

1. **Opening**: "Rate this signal on how directly it [describes what the signal must show]."

2. **Subject requirement**: Who or what must the signal be about? Be explicit:
   - For role-based signals: specify exact titles that qualify (and which DON'T)
   - For market signals: specify the DIRECTION (who is the subject — new entrant vs incumbent, the company leaving vs joining)
   - For event signals: specify what the event IS vs what it ISN'T

3. **Score 90-100**: Exact match. Include 1-2 concrete headline examples in quotes.

4. **Score 70-89**: Strong but not exact. What's missing vs a 90+?

5. **Score 50-69**: Tangential. Shares keywords but wrong context.

6. **Score BELOW 50 (MOST IMPORTANT SECTION)**: Explicit rejection rules. List 3-5 specific patterns that look like matches but AREN'T. These are the tricky false positives.
${isJobPost ? `
   Common job post false positives to address:
   - Adjacent department roles (HR/Compensation/Operations that share keywords with marketing)
   - Junior roles matching senior signals (Coordinator ≠ Director ≠ VP ≠ C-level)
   - The word "temporary" or "contract" in a non-marketing role does NOT make it an "interim CMO"
   - SEO/Content/Social media specialists are NOT "Marketing Transformation" or "AI Marketing" roles unless the title explicitly says so
` : ""}
${isNews ? `
   Common news false positives to address:
   - The target company doing something new ≠ "new entrant" (the signal is about someone ELSE entering THEIR market)
   - A person from a different department leaving ≠ "senior marketer exits" (verify the person's actual role)
   - A company partnership ≠ "new entrant threatening" (partnership means they're working together, not competing)
   - Any executive making any statement ≠ "exec reframes success metrics" (must be specifically about changing KPIs)
   - General company news that shares a keyword is NOT a match (keyword co-occurrence ≠ signal relevance)
` : ""}

7. **Examples with scores**: 3 examples including at least 1 false positive that should score below 40.

The prompt should be 200-350 words. The #1 quality metric is PRECISION over RECALL — it's much better to miss a real signal than to surface a wrong one. When in doubt, the prompt should drive scores LOWER.

Return ONLY the scoring prompt text. No quotes, no explanation, no markdown.`,
        },
        {
          role: "user",
          content: `Task: "${taskName}"
Description: ${taskDescription || "N/A"}
Keywords: ${(taskKeywords || []).join(", ") || "N/A"}
Job Title Keywords: ${(taskJobTitleKeywords || []).join(", ") || "N/A"}
Signal Sources: ${(taskSources || []).join(", ") || "N/A"}`,
        },
      ],
    });
    const prompt = completion.choices[0]?.message?.content?.trim() || "";
    return { scoringPrompt: prompt };
  } catch (e) {
    console.error("Scoring prompt generation error:", e);
    const kws = [...(taskKeywords || []), ...(taskJobTitleKeywords || [])].slice(0, 5).join(", ");
    return {
      scoringPrompt: `Rate the relevance of this signal for detecting "${taskName}" at the target company. Score 90-100 ONLY if it directly and explicitly matches the core signal (${kws}). Score 70-89 for strong alignment with minor gaps. Score 50-69 for partial relevance. Score below 50 — and be aggressive here — if the signal is only tangentially related, uses similar keywords in a different context, or describes a different type of event/role than what this task tracks. When in doubt, score lower.`,
    };
  }
}

// AI-powered deduplication — groups tasks by company, identifies semantic duplicates
async function dedupTasks(taskGroups) {
  // taskGroups: [{company, tasks: [{signal, taskRule, score, taskType, url, idx}]}]
  const results = []; // indices to KEEP

  for (const group of taskGroups) {
    if (group.tasks.length <= 1) {
      results.push(...group.tasks.map(t => t.idx));
      continue;
    }

    try {
      const taskList = group.tasks.map((t, i) => 
        `[${i}] Rule:"${t.taskRule}" | Signal:"${t.signal}" | URL:${t.url || "none"} | Score:${t.score}`
      ).join("\n");

      const completion = await openai.chat.completions.create({
        model: "gpt-4.1-mini",
        temperature: 0,
        max_tokens: 600,
        messages: [
          { role: "system", content: `You are a deduplication engine. Given a list of B2B signal tasks for the same company, identify which ones are semantically duplicated (same underlying event/signal described differently). Return ONLY a JSON object: {"keep": [0, 2, 5]}. Keep the task with the highest score when merging duplicates. ONLY remove true duplicates where the underlying real-world event is the same. No markdown.` },
          { role: "user", content: `Company: ${group.company}\n\nTasks:\n${taskList}` }
        ],
      });

      const text = completion.choices[0]?.message?.content || "{}";
      const cleaned = text.replace(/```json\n?|```/g, "").trim();
      let keepIdxs;
      try {
        const data = JSON.parse(cleaned);
        keepIdxs = data.keep || group.tasks.map((_, i) => i);
      } catch (_) {
        // Try extracting keep array from truncated JSON
        const m = cleaned.match(/\[[\d,\s]+\]/);
        keepIdxs = m ? JSON.parse(m[0]) : group.tasks.map((_, i) => i);
      }
      results.push(...keepIdxs.map(i => group.tasks[i]?.idx).filter(i => i !== undefined));
    } catch (e) {
      console.error("AI dedup error for", group.company, ":", e.message);
      // On error, keep all
      results.push(...group.tasks.map(t => t.idx));
    }
  }

  return { keepIndices: results };
}

export async function POST(request) {
  try {
    const body = await request.json();
    const { action } = body;

    if (!process.env.OPENAI_API_KEY) {
      return NextResponse.json(
        { error: "OPENAI_API_KEY not configured" },
        { status: 500 }
      );
    }

    switch (action) {
      case "classify": {
        const { newsItem, taskDefs, companyName } = body;
        const result = await classifyNews(newsItem, taskDefs, companyName);
        return NextResponse.json(result);
      }

      case "refine": {
        const { userInput } = body;
        const result = await refineTask(userInput);
        return NextResponse.json(result);
      }

      case "insights": {
        const { task, companyName } = body;
        const result = await generateInsights(task, companyName);
        return NextResponse.json(result);
      }

      case "generate_job_keywords": {
        const { taskName, taskDescription } = body;
        const result = await generateJobKeywords(taskName, taskDescription);
        return NextResponse.json(result);
      }

      case "generate_scoring_prompt": {
        const { taskName, taskDescription, taskKeywords, taskSources, taskJobTitleKeywords } = body;
        const result = await generateScoringPrompt(taskName, taskDescription, taskKeywords, taskSources, taskJobTitleKeywords);
        return NextResponse.json(result);
      }

      case "dedup_tasks": {
        const { taskGroups } = body;
        const result = await dedupTasks(taskGroups || []);
        return NextResponse.json(result);
      }

      default:
        return NextResponse.json({ error: "Unknown action" }, { status: 400 });
    }
  } catch (error) {
    console.error("Classify API error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
