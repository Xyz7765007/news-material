import { NextResponse } from "next/server";
import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Classify a news item against task definitions
async function classifyNews(newsItem, taskDefs, companyName) {
  const taskList = taskDefs
    .map(
      (t) =>
        `ID:${t.id} | "${t.name}" | Keywords: ${(t.keywords || []).join(", ")} | Sources: ${(t.sources || []).join(", ")}`
    )
    .join("\n");

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4.1",
      temperature: 0.2,
      max_tokens: 500,
      messages: [
        {
          role: "system",
          content: `You are a B2B signal classification engine. Given a news headline about a company and a list of task definitions, determine which tasks (if any) this news item triggers. Consider keyword matches, semantic relevance, and signal intent. Return ONLY a JSON object: {"matchedTaskIds": ["id1", "id2"], "confidence": 0.0-1.0, "reasoning": "brief explanation"}. If no tasks match, return {"matchedTaskIds": [], "confidence": 0, "reasoning": "No relevant signal detected"}.`,
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
  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4.1",
      temperature: 0.3,
      max_tokens: 500,
      messages: [
        {
          role: "system",
          content: `You generate scoring criteria prompts for a B2B signal intelligence tool. Given a task definition, create a clear, specific scoring prompt that an AI will use to rate the relevance of signals (news articles or job postings) from 0-100.

The prompt should:
1. Clearly define what constitutes a 90-100 (exact match), 70-89 (strong), 50-69 (partial), and below 50 (weak/irrelevant)
2. Reference specific titles, keywords, or themes from the task
3. Be 3-5 sentences, detailed enough that a different AI can score consistently using it
4. Be written in second person ("Rate this signal...")
5. Include specific examples of what scores 90+ vs 70+ vs below 50

Return ONLY the scoring prompt text, nothing else. No quotes, no explanation.`,
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
      scoringPrompt: `Rate the relevance of this signal for detecting "${taskName}" at the target company. Score 90-100 if it directly matches key indicators (${kws}). Score 70-89 for strong thematic alignment. Score 50-69 for partial or indirect relevance. Score below 50 if unrelated.`,
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
        max_tokens: 300,
        messages: [
          { role: "system", content: `You are a deduplication engine. Given a list of B2B signal tasks for the same company, identify which ones are semantically duplicated (same underlying event/signal described differently). Return ONLY a JSON object: {"keep": [0, 2, 5], "removed": [{"idx": 1, "duplicate_of": 0, "reason": "same hiring event"}]}. Keep the task with the highest score when merging duplicates. ONLY remove true duplicates where the underlying real-world event is the same.` },
          { role: "user", content: `Company: ${group.company}\n\nTasks:\n${taskList}` }
        ],
      });

      const text = completion.choices[0]?.message?.content || "{}";
      const cleaned = text.replace(/```json\n?|```/g, "").trim();
      const data = JSON.parse(cleaned);
      const keepIdxs = data.keep || group.tasks.map((_, i) => i);
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
