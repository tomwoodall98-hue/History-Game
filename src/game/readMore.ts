/**
 * The only way the game reaches Wikipedia, and the spoiler guard for it.
 *
 * A question's article title names its answer ("Storming of the Bastille"),
 * so nothing about a question may be fetched, or put in the page, until the
 * player's guess for it is locked in. This holds the day's questions and
 * reads the rounds played so far; a question is open for reading only once
 * its round is recorded (and, for an article two questions share, once both
 * are). Everything else is refused before any URL is made.
 */
import type { Question, RoundResult } from './types';
import { summaryUrl, type SummaryCache, type WikiSummary } from './wikipedia';

/** Two sources name the same article if they ask Wikipedia for the same summary. */
const articleKey = (source: string) => summaryUrl(source) ?? source;

export class ReadMore {
  constructor(
    private readonly questions: readonly Question[],
    /** The rounds confirmed so far, in order. */
    private readonly rounds: () => readonly RoundResult[],
    /** Null when there is no network to ask (the panel then shows the note and link alone). */
    private readonly summaries: SummaryCache | null,
  ) {}

  /**
   * Whether question `i` can be read about: its guess is confirmed, and so is
   * every other question of the day citing the same article (an article on
   * two events would give the later one away).
   */
  unlocked(i: number): boolean {
    const q = this.questions[i];
    if (!q || !this.answered(i)) return false;
    const article = articleKey(q.source);
    return this.questions.every((other, j) => j === i || articleKey(other.source) !== article || this.answered(j));
  }

  private answered(i: number): boolean {
    const r = this.rounds()[i];
    return r != null && r.questionId === this.questions[i]?.id;
  }

  /** Starts fetching a confirmed question's summary, e.g. while its reveal plays. */
  prefetch(i: number): void {
    if (this.unlocked(i)) void this.summaries?.get(this.questions[i].source);
  }

  /** A confirmed question's summary; null if there's none or it didn't arrive in time. */
  summary(i: number): Promise<WikiSummary | null> {
    if (!this.unlocked(i)) return Promise.reject(new Error(`Question ${i + 1} has no confirmed guess yet`));
    return this.summaries ? this.summaries.get(this.questions[i].source) : Promise.resolve(null);
  }

  /** The article link for a confirmed question; null before then. */
  articleUrl(i: number): string | null {
    return this.unlocked(i) ? this.questions[i].source : null;
  }
}
