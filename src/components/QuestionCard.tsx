import { useMemo, useState } from "react";

/** opencode 服务端表单字段（Form.Field 的子集；未知类型按文本输入兜底）。 */
export type QuestionOption = { value: string; label: string; description?: string };
export type QuestionField = {
  key: string;
  type: string;
  title?: string;
  description?: string;
  required?: boolean;
  hidden?: boolean;
  options?: QuestionOption[];
  default?: unknown;
  placeholder?: string;
  minimum?: number;
  maximum?: number;
  /** 允许选项之外自由作答（上游 question 工具自动附加「Type your own answer」）；默认 true */
  custom?: boolean;
};

const fieldLabel = (field: QuestionField) => field.title || field.key;

/** 模型提问卡片：把 opencode/zcode 的 form 字段渲染成可作答的控件。
 *  多题时走向导（逐题作答 → 复核 → 整体提交，ZCode question-state 同款语义）；
 *  单题保持一步直答。焦点只服务导航，数据只存 answers——严格分离。 */
export default function QuestionCard({
  title,
  fields,
  onSubmit,
  onSkip,
}: {
  title?: string;
  fields: QuestionField[];
  onSubmit: (answer: Record<string, unknown>) => void;
  onSkip: () => void;
}) {
  const visible = useMemo(() => (fields ?? []).filter((field) => !field.hidden), [fields]);
  const wizard = visible.length > 1;
  const [answers, setAnswers] = useState<Record<string, unknown>>(() => {
    const initial: Record<string, unknown> = {};
    for (const field of visible) if (field.default !== undefined) initial[field.key] = field.default;
    return initial;
  });
  const [step, setStep] = useState(0);
  const [reviewing, setReviewing] = useState(false);
  const [sent, setSent] = useState(false);

  const setValue = (key: string, value: unknown) =>
    setAnswers((prev) => ({ ...prev, [key]: value }));
  const empty = (value: unknown) =>
    value === undefined || value === "" || (Array.isArray(value) && value.length === 0);
  const missing = (field: QuestionField) => field.required && empty(answers[field.key]);

  const submitAll = () => {
    if (sent) return;
    setSent(true);
    const payload: Record<string, unknown> = {};
    for (const field of visible) {
      if (!empty(answers[field.key])) payload[field.key] = answers[field.key];
    }
    onSubmit(payload);
  };
  const skipAll = () => {
    if (sent) return;
    setSent(true);
    onSkip();
  };

  const choose = (label: string, active: boolean, onClick: () => void) => (
    <button
      key={label}
      onClick={onClick}
      className={`block w-full rounded-lg border px-3 py-2 text-left transition-colors ${
        active ? "border-amber-400 bg-amber-50/60" : "border-stone-200 bg-white hover:border-amber-400 hover:bg-amber-50/50"
      }`}
    >
      <div className="text-xs font-medium text-stone-700">{label}</div>
    </button>
  );

  const renderField = (field: QuestionField) => {
    const value = answers[field.key];
    if (field.type === "external") {
      return field.description || field.key ? (
        <div className="text-[11px] text-stone-500">{field.description ?? field.key}</div>
      ) : null;
    }
    if (field.type === "boolean") {
      return (
        <div className="space-y-1.5">
          {[
            { label: "是", val: true },
            { label: "否", val: false },
          ].map((option) => choose(option.label, value === option.val, () => setValue(field.key, option.val)))}
        </div>
      );
    }
    if (field.type === "multiselect") {
      const selected = Array.isArray(value) ? (value as string[]) : [];
      return (
        <div className="space-y-1.5">
          {(field.options ?? []).map((option) =>
            choose(option.label, selected.includes(option.value), () =>
              setValue(
                field.key,
                selected.includes(option.value)
                  ? selected.filter((item) => item !== option.value)
                  : [...selected, option.value],
              ),
            ),
          )}
        </div>
      );
    }
    if ((field.type === "string" || field.type === "number" || field.type === "integer") && field.options?.length) {
      return (
        <div className="space-y-1.5">
          {(field.options ?? []).map((option) => (
            <button
              key={option.value}
              onClick={() => setValue(field.key, option.value)}
              className={`block w-full rounded-lg border px-3 py-2 text-left transition-colors ${
                value === option.value
                  ? "border-amber-400 bg-amber-50/60"
                  : "border-stone-200 bg-white hover:border-amber-400 hover:bg-amber-50/50"
              }`}
            >
              <div className="text-xs font-medium text-stone-700">{option.label}</div>
              {option.description && <div className="mt-0.5 text-[11px] text-stone-500">{option.description}</div>}
            </button>
          ))}
          {/* 自定义回答：上游 question 工具自动附加「Type your own answer」选项（custom 字段），自填值优先于点选 */}
          {field.custom !== false && (
            <input
              aria-label={`${fieldLabel(field)}（自定义回答）`}
              placeholder="其他（自定义回答）…"
              value={typeof value === "string" && !field.options?.some((o) => o.value === value) ? value : ""}
              onChange={(event) => setValue(field.key, event.target.value === "" ? undefined : event.target.value)}
              className="w-full rounded-lg border border-stone-200 bg-white px-3 py-2 text-xs text-stone-700 outline-none focus:border-amber-400"
            />
          )}
        </div>
      );
    }
    if (field.type === "number" || field.type === "integer") {
      return (
        <input
          type="number"
          aria-label={fieldLabel(field)}
          min={field.minimum}
          max={field.maximum}
          step={field.type === "integer" ? 1 : undefined}
          value={value === undefined ? "" : String(value)}
          onChange={(event) => setValue(field.key, event.target.value === "" ? undefined : Number(event.target.value))}
          className="w-full rounded-lg border border-stone-200 bg-white px-3 py-2 text-xs text-stone-700 outline-none focus:border-amber-400"
        />
      );
    }
    return (
      <input
        aria-label={fieldLabel(field)}
        value={value === undefined ? "" : String(value)}
        placeholder={field.placeholder}
        onChange={(event) => setValue(field.key, event.target.value)}
        className="w-full rounded-lg border border-stone-200 bg-white px-3 py-2 text-xs text-stone-700 outline-none focus:border-amber-400"
      />
    );
  };

  const fieldHeader = (field: QuestionField, showRequired: boolean) => (
    <div className="space-y-1">
      <div className="text-[11px] text-stone-500">
        {fieldLabel(field)}
        {showRequired && field.required && <span className="text-amber-700"> *</span>}
      </div>
      {field.description && field.type !== "external" && (
        <div className="text-[11px] text-stone-400">{field.description}</div>
      )}
      {renderField(field)}
    </div>
  );

  // 复核阶段（仅多题）：逐题列出答案，可返回修改或整体提交
  if (wizard && reviewing) {
    return (
      <div className="space-y-3">
        <div className="flex items-center gap-2 text-xs font-medium text-amber-800">
          <span className="rounded bg-amber-200/70 px-1.5 py-0.5 font-mono text-[10px]">提问</span>
          {title || "确认你的回答"}
        </div>
        <div className="space-y-2">
          {visible.map((field) => {
            const value = answers[field.key];
            const shown = empty(value)
              ? "未回答"
              : Array.isArray(value) ? value.join("、") : String(value);
            return (
              <div key={field.key} className="flex items-start justify-between gap-3 rounded-lg bg-white/70 px-3 py-2">
                <div className="min-w-0">
                  <div className="text-[11px] text-stone-500">{fieldLabel(field)}</div>
                  <div className="truncate text-xs font-medium text-stone-700">{shown}</div>
                </div>
                <button
                  className="shrink-0 text-[11px] text-amber-700 hover:underline"
                  onClick={() => { setReviewing(false); setStep(visible.indexOf(field)); }}
                >
                  修改
                </button>
              </div>
            );
          })}
        </div>
        <div className="flex items-center gap-2 pt-0.5">
          <button disabled={sent} onClick={submitAll} className="task-action task-action-primary disabled:opacity-50">
            提交全部
          </button>
          <button
            disabled={sent}
            onClick={() => setReviewing(false)}
            className="rounded-full border border-stone-300 px-3.5 py-1 text-xs text-stone-600 transition-colors hover:bg-stone-100 disabled:opacity-50"
          >
            返回修改
          </button>
          <span className="text-[11px] text-stone-400">Agent 正在等待你的回答</span>
        </div>
      </div>
    );
  }

  // 向导模式：逐题作答
  if (wizard && !reviewing) {
    const field = visible[Math.min(step, visible.length - 1)];
    const blocked = missing(field);
    const last = step === visible.length - 1;
    return (
      <div className="space-y-3">
        <div className="flex items-center gap-2 text-xs font-medium text-amber-800">
          <span className="rounded bg-amber-200/70 px-1.5 py-0.5 font-mono text-[10px]">提问</span>
          {title || "Agent 需要你的回答"}
          <span className="text-stone-400">{step + 1}/{visible.length}</span>
        </div>
        {fieldHeader(field, true)}
        <div className="flex items-center gap-2 pt-0.5">
          {step > 0 && (
            <button
              onClick={() => setStep(step - 1)}
              className="rounded-full border border-stone-300 px-3.5 py-1 text-xs text-stone-600 transition-colors hover:bg-stone-100"
            >
              上一题
            </button>
          )}
          <button
            disabled={blocked || sent}
            onClick={() => (last ? setReviewing(true) : setStep(step + 1))}
            className="task-action task-action-primary disabled:opacity-50"
          >
            {last ? "复核回答" : "下一题"}
          </button>
          <button
            disabled={sent}
            onClick={() => {
              setValue(field.key, undefined);
              if (last) setReviewing(true); else setStep(step + 1);
            }}
            className="rounded-full border border-stone-300 px-3.5 py-1 text-xs text-stone-600 transition-colors hover:bg-stone-100 disabled:opacity-50"
          >
            跳过本题
          </button>
          <span className="text-[11px] text-stone-400">Agent 正在等待你的回答</span>
        </div>
      </div>
    );
  }

  // 单题：一步直答（保持既有交互，不引入复核步骤）
  const single = visible[0];
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-xs font-medium text-amber-800">
        <span className="rounded bg-amber-200/70 px-1.5 py-0.5 font-mono text-[10px]">提问</span>
        {title || "Agent 需要你确认"}
      </div>
      {single ? fieldHeader(single, true) : null}
      <div className="flex items-center gap-2 pt-0.5">
        <button
          disabled={missing(single) || sent || !single}
          onClick={submitAll}
          className="task-action task-action-primary disabled:opacity-50"
        >
          提交
        </button>
        <button
          disabled={sent}
          onClick={skipAll}
          className="rounded-full border border-stone-300 px-3.5 py-1 text-xs text-stone-600 transition-colors hover:bg-stone-100 disabled:opacity-50"
        >
          跳过
        </button>
        <span className="text-[11px] text-stone-400">Agent 正在等待你的回答</span>
      </div>
    </div>
  );
}
