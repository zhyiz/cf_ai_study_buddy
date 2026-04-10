import { routeAgentRequest, unstable_callable as callable } from "agents";
import { AIChatAgent } from "agents/ai-chat-agent";
import { createWorkersAI } from "workers-ai-provider";
import { streamText, convertToModelMessages } from "ai";

// ── Types ───────────────────────────────────────────────────────────
export type Flashcard = {
  id: string;
  question: string;
  answer: string;
  topic: string;
  nextReview: string; // ISO date
  interval: number;   // days until next review
  easeFactor: number; // SM-2 ease factor
  repetitions: number;
  createdAt: string;
};

export type StudyStats = {
  totalCards: number;
  dueCards: number;
  studiedToday: number;
  streak: number;
};

export type AgentState = {
  currentTopic: string | null;
  stats: StudyStats;
};

// ── Agent ───────────────────────────────────────────────────────────
export class StudyBuddyAgent extends AIChatAgent<Env, AgentState> {
  initialState: AgentState = {
    currentTopic: null,
    stats: { totalCards: 0, dueCards: 0, studiedToday: 0, streak: 0 },
  };

  onStart() {
    // Create flashcards table on first run
    this.sql`
      CREATE TABLE IF NOT EXISTS flashcards (
        id TEXT PRIMARY KEY,
        question TEXT NOT NULL,
        answer TEXT NOT NULL,
        topic TEXT NOT NULL,
        next_review TEXT NOT NULL,
        interval_days REAL NOT NULL DEFAULT 1,
        ease_factor REAL NOT NULL DEFAULT 2.5,
        repetitions INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `;
    this.sql`
      CREATE TABLE IF NOT EXISTS study_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        card_id TEXT NOT NULL,
        quality INTEGER NOT NULL,
        studied_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `;
    this.refreshStats();
  }

  // ── Chat Handler ──────────────────────────────────────────────────
  async onChatMessage(onFinish?: Parameters<AIChatAgent["onChatMessage"]>[0]) {
    const workersai = createWorkersAI({ binding: this.env.AI });

    const dueCards = this.getDueCards();
    const allTopics = this.getTopics();

    const systemPrompt = `You are Study Buddy, an AI-powered study assistant. You help users learn topics by explaining concepts, generating flashcards, and quizzing them.

Current context:
- Topics studied: ${allTopics.length > 0 ? allTopics.join(", ") : "none yet"}
- Flashcards due for review: ${dueCards.length}
- Total flashcards: ${this.state.stats.totalCards}

You have these capabilities (use the EXACT format when the user asks):
1. When the user wants to create flashcards, respond with flashcard blocks like:
   [FLASHCARD]
   Q: <question>
   A: <answer>
   T: <topic>
   [/FLASHCARD]
   You can include multiple flashcard blocks in one response. Always create flashcards when explaining a new topic.

2. When the user wants to review/quiz, present due flashcards one at a time. Show only the question, then after the user answers, evaluate their response and show the correct answer.

3. Explain topics clearly with examples. Break complex topics into digestible parts.

4. When greeting a user or if they're unsure what to do, suggest:
   - "Teach me about [topic]" to learn something new
   - "Quiz me" to review due flashcards
   - "Show my progress" to see study stats

Keep responses concise and focused. Use markdown formatting for clarity.`;

    const result = streamText({
      model: workersai("@cf/meta/llama-3.3-70b-instruct-fp8-fast"),
      system: systemPrompt,
      messages: await convertToModelMessages(this.messages as any),
      onFinish: async (result) => {
        // Parse flashcards from the response
        const text = result.text;
        const cardPattern = /\[FLASHCARD\]\s*Q:\s*(.+?)\s*A:\s*(.+?)\s*T:\s*(.+?)\s*\[\/FLASHCARD\]/gs;
        let match;
        while ((match = cardPattern.exec(text)) !== null) {
          this.createFlashcard(match[1].trim(), match[2].trim(), match[3].trim());
        }
        this.refreshStats();
        if (onFinish) {
          onFinish(result as any);
        }
      },
    });

    return result.toUIMessageStreamResponse();
  }

  // ── Flashcard CRUD ────────────────────────────────────────────────
  private createFlashcard(question: string, answer: string, topic: string) {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    this.sql`
      INSERT INTO flashcards (id, question, answer, topic, next_review, created_at)
      VALUES (${id}, ${question}, ${answer}, ${topic}, ${now}, ${now})
    `;
    return id;
  }

  private getDueCards(): Flashcard[] {
    const now = new Date().toISOString();
    return this.sql<Flashcard>`
      SELECT id, question, answer, topic, next_review as nextReview,
             interval_days as interval, ease_factor as easeFactor,
             repetitions, created_at as createdAt
      FROM flashcards
      WHERE next_review <= ${now}
      ORDER BY next_review ASC
      LIMIT 20
    `;
  }

  private getTopics(): string[] {
    const rows = this.sql<{ topic: string }>`
      SELECT DISTINCT topic FROM flashcards ORDER BY topic
    `;
    return rows.map((r) => r.topic);
  }

  // ── Callable Methods (exposed to client) ──────────────────────────
  @callable()
  getFlashcards(topic?: string): Flashcard[] {
    if (topic) {
      return this.sql<Flashcard>`
        SELECT id, question, answer, topic, next_review as nextReview,
               interval_days as interval, ease_factor as easeFactor,
               repetitions, created_at as createdAt
        FROM flashcards WHERE topic = ${topic} ORDER BY created_at DESC
      `;
    }
    return this.sql<Flashcard>`
      SELECT id, question, answer, topic, next_review as nextReview,
             interval_days as interval, ease_factor as easeFactor,
             repetitions, created_at as createdAt
      FROM flashcards ORDER BY created_at DESC
    `;
  }

  @callable()
  getDueFlashcards(): Flashcard[] {
    return this.getDueCards();
  }

  @callable()
  reviewCard(cardId: string, quality: number): { nextReview: string; interval: number } {
    // SM-2 spaced repetition algorithm
    const cards = this.sql<Flashcard>`
      SELECT id, ease_factor as easeFactor, interval_days as interval, repetitions
      FROM flashcards WHERE id = ${cardId}
    `;
    if (cards.length === 0) throw new Error("Card not found");

    const card = cards[0];
    let { easeFactor, interval, repetitions } = card;

    // quality: 0-5 (0=total blackout, 5=perfect response)
    if (quality < 3) {
      repetitions = 0;
      interval = 1;
    } else {
      if (repetitions === 0) {
        interval = 1;
      } else if (repetitions === 1) {
        interval = 6;
      } else {
        interval = Math.round(interval * easeFactor);
      }
      repetitions += 1;
    }

    easeFactor = Math.max(1.3, easeFactor + (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02)));

    const nextReview = new Date(Date.now() + interval * 86400000).toISOString();

    this.sql`
      UPDATE flashcards
      SET ease_factor = ${easeFactor}, interval_days = ${interval},
          repetitions = ${repetitions}, next_review = ${nextReview}
      WHERE id = ${cardId}
    `;

    this.sql`INSERT INTO study_log (card_id, quality) VALUES (${cardId}, ${quality})`;

    this.refreshStats();
    return { nextReview, interval };
  }

  @callable()
  deleteCard(cardId: string) {
    this.sql`DELETE FROM flashcards WHERE id = ${cardId}`;
    this.refreshStats();
  }

  @callable()
  getStudyStats(): StudyStats {
    return this.computeStats();
  }

  @callable()
  listTopics(): string[] {
    return this.getTopics();
  }

  // ── Internal ──────────────────────────────────────────────────────
  private computeStats(): StudyStats {
    const now = new Date().toISOString();
    const today = new Date().toISOString().slice(0, 10);

    const totalRows = this.sql<{ cnt: number }>`SELECT COUNT(*) as cnt FROM flashcards`;
    const dueRows = this.sql<{ cnt: number }>`
      SELECT COUNT(*) as cnt FROM flashcards WHERE next_review <= ${now}
    `;
    const todayRows = this.sql<{ cnt: number }>`
      SELECT COUNT(*) as cnt FROM study_log WHERE studied_at >= ${today}
    `;

    return {
      totalCards: totalRows[0]?.cnt ?? 0,
      dueCards: dueRows[0]?.cnt ?? 0,
      studiedToday: todayRows[0]?.cnt ?? 0,
      streak: 0,
    };
  }

  private refreshStats() {
    const stats = this.computeStats();
    this.setState({ ...this.state, stats });
  }
}

// ── Worker Entry ────────────────────────────────────────────────────
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    return (
      (await routeAgentRequest(request, env)) ??
      new Response("Not found", { status: 404 })
    );
  },
} satisfies ExportedHandler<Env>;
