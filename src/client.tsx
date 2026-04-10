import { useState, useRef, useEffect } from "react";
import { useAgent } from "agents/react";
import type { AgentState, Flashcard } from "./server";
import "./styles.css";

type View = "chat" | "cards" | "review";

export default function App() {
  const [state, setAgentState] = useState<AgentState>({
    currentTopic: null,
    stats: { totalCards: 0, dueCards: 0, studiedToday: 0, streak: 0 },
  });
  const [view, setView] = useState<View>("chat");
  const [messages, setMessages] = useState<Array<{ role: string; content: string }>>([]);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [flashcards, setFlashcards] = useState<Flashcard[]>([]);
  const [reviewQueue, setReviewQueue] = useState<Flashcard[]>([]);
  const [showAnswer, setShowAnswer] = useState(false);
  const [selectedTopic, setSelectedTopic] = useState<string>("all");
  const [topics, setTopics] = useState<string[]>([]);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const agent = useAgent<AgentState>({
    agent: "StudyBuddyAgent",
    onStateUpdate: (s) => setAgentState(s),
  });

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    if (!agent) return;
    if (view === "cards") {
      loadFlashcards();
      loadTopics();
    } else if (view === "review") {
      loadDueCards();
    }
  }, [view, agent]);

  const loadFlashcards = async () => {
    if (!agent) return;
    const cards = await agent.call<Flashcard[]>(
      "getFlashcards",
      selectedTopic === "all" ? [] : [selectedTopic]
    );
    setFlashcards(cards);
  };

  const loadTopics = async () => {
    if (!agent) return;
    const t = await agent.call<string[]>("listTopics");
    setTopics(t);
  };

  const loadDueCards = async () => {
    if (!agent) return;
    const cards = await agent.call<Flashcard[]>("getDueFlashcards");
    setReviewQueue(cards);
    setShowAnswer(false);
  };

  // ── Chat ──────────────────────────────────────────────────────────
  const sendMessage = async () => {
    if (!input.trim() || isStreaming) return;

    const userMsg = { role: "user", content: input.trim() };
    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setIsStreaming(true);

    try {
      const response = await fetch("/agents/StudyBuddyAgent/default", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [...messages, userMsg].map((m) => ({
            role: m.role,
            content: m.content,
          })),
        }),
      });

      if (!response.ok || !response.body) {
        throw new Error("Stream failed");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let assistantContent = "";

      setMessages((prev) => [...prev, { role: "assistant", content: "" }]);

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split("\n");
        for (const line of lines) {
          if (line.startsWith("0:")) {
            try {
              const text = JSON.parse(line.slice(2));
              assistantContent += text;
              setMessages((prev) => {
                const updated = [...prev];
                updated[updated.length - 1] = {
                  role: "assistant",
                  content: assistantContent,
                };
                return updated;
              });
            } catch {
              // skip non-JSON lines
            }
          }
        }
      }
    } catch {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: "Sorry, something went wrong. Please try again." },
      ]);
    }

    setIsStreaming(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  // ── Review ────────────────────────────────────────────────────────
  const reviewAnswer = async (quality: number) => {
    if (reviewQueue.length === 0 || !agent) return;
    const card = reviewQueue[0];
    await agent.call("reviewCard", [card.id, quality]);
    setReviewQueue((prev) => prev.slice(1));
    setShowAnswer(false);
  };

  const deleteFlashcard = async (cardId: string) => {
    if (!agent) return;
    await agent.call("deleteCard", [cardId]);
    loadFlashcards();
  };

  // ── Render ────────────────────────────────────────────────────────
  return (
    <div className="app">
      <header className="header">
        <h1>Study Buddy</h1>
        <div className="stats-bar">
          <span className="stat" title="Total flashcards">
            {state.stats.totalCards} cards
          </span>
          <span className="stat due" title="Due for review">
            {state.stats.dueCards} due
          </span>
          <span className="stat" title="Studied today">
            {state.stats.studiedToday} today
          </span>
        </div>
      </header>

      <nav className="nav">
        <button
          className={view === "chat" ? "active" : ""}
          onClick={() => setView("chat")}
        >
          Chat
        </button>
        <button
          className={view === "cards" ? "active" : ""}
          onClick={() => setView("cards")}
        >
          Flashcards
        </button>
        <button
          className={view === "review" ? "active" : ""}
          onClick={() => setView("review")}
        >
          Review {state.stats.dueCards > 0 && `(${state.stats.dueCards})`}
        </button>
      </nav>

      <main className="content">
        {view === "chat" && (
          <div className="chat-view">
            <div className="messages">
              {messages.length === 0 && (
                <div className="welcome">
                  <h2>Welcome to Study Buddy</h2>
                  <p>I can help you learn any topic. Try:</p>
                  <div className="suggestions">
                    {[
                      "Teach me about photosynthesis",
                      "Explain how TCP/IP works",
                      "Quiz me on my flashcards",
                      "Show my study progress",
                    ].map((s) => (
                      <button
                        key={s}
                        className="suggestion"
                        onClick={() => setInput(s)}
                      >
                        {s}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {messages.map((msg, i) => (
                <div key={i} className={`message ${msg.role}`}>
                  <div className="message-content">
                    {msg.role === "assistant" ? (
                      <div dangerouslySetInnerHTML={{ __html: formatMarkdown(msg.content) }} />
                    ) : (
                      <p>{msg.content}</p>
                    )}
                  </div>
                </div>
              ))}
              <div ref={messagesEndRef} />
            </div>
            <div className="input-area">
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Ask me anything..."
                rows={1}
                disabled={isStreaming}
              />
              <button onClick={sendMessage} disabled={isStreaming || !input.trim()}>
                {isStreaming ? "..." : "Send"}
              </button>
            </div>
          </div>
        )}

        {view === "cards" && (
          <div className="cards-view">
            <div className="cards-header">
              <h2>My Flashcards</h2>
              <select
                value={selectedTopic}
                onChange={(e) => {
                  setSelectedTopic(e.target.value);
                  setTimeout(loadFlashcards, 0);
                }}
              >
                <option value="all">All Topics</option>
                {topics.map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
            </div>
            {flashcards.length === 0 ? (
              <div className="empty-state">
                <p>No flashcards yet. Start chatting to create some!</p>
              </div>
            ) : (
              <div className="flashcard-grid">
                {flashcards.map((card) => (
                  <div key={card.id} className="flashcard">
                    <div className="card-topic">{card.topic}</div>
                    <div className="card-question">{card.question}</div>
                    <div className="card-answer">{card.answer}</div>
                    <div className="card-actions">
                      <span className="card-meta">
                        Rep: {card.repetitions} | Next:{" "}
                        {new Date(card.nextReview).toLocaleDateString()}
                      </span>
                      <button
                        className="delete-btn"
                        onClick={() => deleteFlashcard(card.id)}
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {view === "review" && (
          <div className="review-view">
            {reviewQueue.length === 0 ? (
              <div className="empty-state">
                <h2>All caught up!</h2>
                <p>No cards due for review right now.</p>
                <button onClick={loadDueCards}>Refresh</button>
              </div>
            ) : (
              <div className="review-card">
                <div className="review-progress">
                  Card 1 of {reviewQueue.length}
                </div>
                <div className="review-topic">{reviewQueue[0].topic}</div>
                <div className="review-question">{reviewQueue[0].question}</div>
                {showAnswer ? (
                  <>
                    <div className="review-answer">{reviewQueue[0].answer}</div>
                    <div className="review-buttons">
                      <button className="quality-btn again" onClick={() => reviewAnswer(1)}>
                        Again
                      </button>
                      <button className="quality-btn hard" onClick={() => reviewAnswer(3)}>
                        Hard
                      </button>
                      <button className="quality-btn good" onClick={() => reviewAnswer(4)}>
                        Good
                      </button>
                      <button className="quality-btn easy" onClick={() => reviewAnswer(5)}>
                        Easy
                      </button>
                    </div>
                  </>
                ) : (
                  <button className="show-answer-btn" onClick={() => setShowAnswer(true)}>
                    Show Answer
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}

function formatMarkdown(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\[FLASHCARD\][\s\S]*?\[\/FLASHCARD\]/g, (match) => {
      const q = match.match(/Q:\s*(.+)/)?.[1] || "";
      const a = match.match(/A:\s*(.+)/)?.[1] || "";
      const t = match.match(/T:\s*(.+)/)?.[1] || "";
      return `<div class="inline-card"><strong>Flashcard saved</strong> [${t}]<br/>Q: ${q}<br/>A: ${a}</div>`;
    })
    .replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>')
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/\n/g, "<br/>");
}
