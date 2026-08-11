"use client";

import { useMemo, useState, type FormEvent } from "react";
import { CheckIcon, LockKeyholeIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/components/utils";
import { useAnswerTaskUserInput } from "@/hooks/use-tasks";
import type { TaskUserInputRequestRow } from "@/lib/types/database";

type QuestionDraft = {
  choice: string;
  text: string;
};

export function StructuredUserInputForm({
  request,
  className,
  sourceTaskTitle,
}: {
  request: TaskUserInputRequestRow;
  className?: string;
  sourceTaskTitle?: string | null;
}) {
  const answerRequest = useAnswerTaskUserInput(request.task_id, request.id);
  const [drafts, setDrafts] = useState<Record<string, QuestionDraft>>({});
  const [error, setError] = useState<string | null>(null);

  const answers = useMemo(() => {
    const result: Record<string, string[]> = {};
    for (const question of request.questions) {
      const draft = drafts[question.id] ?? { choice: "", text: "" };
      let answer = "";
      if (!question.options) answer = draft.text.trim();
      else if (draft.choice === "other") answer = draft.text.trim();
      else if (draft.choice.startsWith("option:")) {
        const index = Number(draft.choice.slice("option:".length));
        answer = question.options[index]?.label ?? "";
      }
      if (!answer) return null;
      result[question.id] = [answer];
    }
    return result;
  }, [drafts, request.questions]);

  const updateDraft = (questionId: string, patch: Partial<QuestionDraft>) => {
    setDrafts((current) => ({
      ...current,
      [questionId]: {
        choice: current[questionId]?.choice ?? "",
        text: current[questionId]?.text ?? "",
        ...patch,
      },
    }));
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!answers) return;
    setError(null);
    try {
      await answerRequest.mutateAsync(answers);
      setDrafts({});
    } catch (submissionError) {
      setError(
        submissionError instanceof Error
          ? submissionError.message
          : "提交失败，请稍后重试",
      );
    }
  };

  return (
    <form
      onSubmit={submit}
      className={cn(
        "flex flex-col gap-4 rounded-lg border border-amber-200 bg-amber-50/70 p-4",
        className,
      )}
    >
      <div className="flex items-start gap-2">
        <LockKeyholeIcon className="mt-0.5 size-4 shrink-0 text-amber-700" />
        <div>
          <p className="text-sm font-semibold text-amber-950">
            AI 正在当前 turn 中等待选择
          </p>
          <p className="mt-0.5 text-xs leading-relaxed text-amber-800">
            {sourceTaskTitle ? `来自「${sourceTaskTitle}」。` : ""}
            提交后同一个 turn 会立即继续，不会重新排队或丢失上下文。
          </p>
        </div>
      </div>

      {request.questions.map((question, questionIndex) => {
        const draft = drafts[question.id] ?? { choice: "", text: "" };
        const inputType = question.isSecret ? "password" : "text";
        return (
          <fieldset
            key={question.id}
            className="flex min-w-0 flex-col gap-2 rounded-md border border-amber-200/80 bg-white/80 p-3"
          >
            <legend className="px-1 text-xs font-medium text-amber-800">
              {question.header} · {questionIndex + 1}/{request.questions.length}
            </legend>
            <p className="text-sm leading-relaxed whitespace-pre-wrap text-foreground">
              {question.question}
            </p>

            {question.options ? (
              <div className="flex flex-col gap-2">
                {question.options.map((option, optionIndex) => {
                  const value = `option:${optionIndex}`;
                  return (
                    <label
                      key={`${question.id}:${optionIndex}`}
                      className={cn(
                        "flex cursor-pointer items-start gap-2 rounded-md border px-3 py-2 transition-colors",
                        draft.choice === value
                          ? "border-amber-400 bg-amber-100/70"
                          : "border-border bg-background hover:bg-muted/50",
                      )}
                    >
                      <input
                        type="radio"
                        name={`${request.id}:${question.id}`}
                        value={value}
                        checked={draft.choice === value}
                        disabled={answerRequest.isPending}
                        onChange={() => updateDraft(question.id, { choice: value })}
                        className="mt-1"
                      />
                      <span className="min-w-0">
                        <span className="block text-sm font-medium">
                          {option.label}
                        </span>
                        {option.description ? (
                          <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">
                            {option.description}
                          </span>
                        ) : null}
                      </span>
                    </label>
                  );
                })}
                {question.isOther ? (
                  <label
                    className={cn(
                      "flex cursor-pointer flex-col gap-2 rounded-md border px-3 py-2",
                      draft.choice === "other"
                        ? "border-amber-400 bg-amber-100/70"
                        : "border-border bg-background hover:bg-muted/50",
                    )}
                  >
                    <span className="flex items-center gap-2 text-sm font-medium">
                      <input
                        type="radio"
                        name={`${request.id}:${question.id}`}
                        value="other"
                        checked={draft.choice === "other"}
                        disabled={answerRequest.isPending}
                        onChange={() =>
                          updateDraft(question.id, { choice: "other" })
                        }
                      />
                      其他
                    </span>
                    {draft.choice === "other" ? (
                      <input
                        type={inputType}
                        aria-label={`${question.header}的其他回答`}
                        value={draft.text}
                        maxLength={10_000}
                        autoComplete="off"
                        disabled={answerRequest.isPending}
                        onChange={(event) =>
                          updateDraft(question.id, { text: event.target.value })
                        }
                        className="h-9 rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                      />
                    ) : null}
                  </label>
                ) : null}
              </div>
            ) : (
              <input
                type={inputType}
                aria-label={question.header}
                value={draft.text}
                maxLength={10_000}
                autoComplete="off"
                disabled={answerRequest.isPending}
                onChange={(event) =>
                  updateDraft(question.id, { text: event.target.value })
                }
                className="h-10 rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              />
            )}
            {question.isSecret ? (
              <p className="text-[11px] text-muted-foreground">
                此回答不会显示在消息记录中，并会在任务结束后从等待记录清除。
              </p>
            ) : null}
          </fieldset>
        );
      })}

      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      <Button
        type="submit"
        size="sm"
        disabled={!answers || answerRequest.isPending}
        className="self-end"
      >
        <CheckIcon />
        {answerRequest.isPending ? "正在提交…" : "提交并继续原 turn"}
      </Button>
    </form>
  );
}
