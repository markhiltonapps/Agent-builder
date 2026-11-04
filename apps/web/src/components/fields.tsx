"use client";

import { useId } from "react";
import type { ValidationIssue } from "@/lib/config";

export type Issues = ValidationIssue[];

/** Messages for exactly this path (not its children). */
export const issuesAt = (issues: Issues, path: string) => issues.filter((i) => i.path === path);

function Shell({
  label,
  hint,
  issues,
  id,
  children,
}: {
  label: string;
  hint?: string;
  issues: Issues;
  id: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="label" htmlFor={id}>{label}</label>
      {children}
      {issues.map((i) => (
        <p key={i.message} id={`${id}-err`} className="mt-1 text-xs text-danger">{i.message}</p>
      ))}
      {hint && !issues.length ? <p className="hint">{hint}</p> : null}
    </div>
  );
}

export function TextField({
  label, value, onChange, path, issues = [], hint, maxLength, placeholder,
}: {
  label: string; value: string; onChange: (v: string) => void; path: string;
  issues?: Issues; hint?: string; maxLength?: number; placeholder?: string;
}) {
  const id = useId();
  const mine = issuesAt(issues, path);
  return (
    <Shell label={label} hint={hint} issues={mine} id={id}>
      <input
        id={id} className="field" value={value} maxLength={maxLength} placeholder={placeholder}
        aria-invalid={mine.length > 0} aria-describedby={mine.length ? `${id}-err` : undefined}
        onChange={(e) => onChange(e.target.value)}
      />
    </Shell>
  );
}

export function AreaField({
  label, value, onChange, path, issues = [], hint, rows = 4, maxLength, mono,
}: {
  label: string; value: string; onChange: (v: string) => void; path: string;
  issues?: Issues; hint?: string; rows?: number; maxLength?: number; mono?: boolean;
}) {
  const id = useId();
  const mine = issuesAt(issues, path);
  return (
    <Shell label={label} hint={hint} issues={mine} id={id}>
      <textarea
        id={id} rows={rows} maxLength={maxLength} value={value}
        className={`field ${mono ? "font-mono text-[0.82rem]" : ""}`}
        aria-invalid={mine.length > 0} aria-describedby={mine.length ? `${id}-err` : undefined}
        onChange={(e) => onChange(e.target.value)}
      />
    </Shell>
  );
}

export function SelectField<T extends string>({
  label, value, onChange, options, hint,
}: {
  label: string; value: T; onChange: (v: T) => void;
  options: { value: T; label: string }[]; hint?: string;
}) {
  const id = useId();
  return (
    <Shell label={label} hint={hint} issues={[]} id={id}>
      <select id={id} className="field" value={value} onChange={(e) => onChange(e.target.value as T)}>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </Shell>
  );
}

export function NumberField({
  label, value, onChange, min, max, hint, path, issues = [],
}: {
  label: string; value: number; onChange: (v: number) => void; min: number; max: number;
  hint?: string; path: string; issues?: Issues;
}) {
  const id = useId();
  const mine = issuesAt(issues, path);
  return (
    <Shell label={label} hint={hint} issues={mine} id={id}>
      <input
        id={id} type="number" className="field" min={min} max={max} value={value}
        aria-invalid={mine.length > 0}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </Shell>
  );
}

/** An ordered list of one-line strings (guardrails). */
export function StringList({
  label, items, onChange, path, issues = [], addLabel, max, hint,
}: {
  label: string; items: string[]; onChange: (v: string[]) => void; path: string;
  issues?: Issues; addLabel: string; max: number; hint?: string;
}) {
  return (
    <fieldset>
      <legend className="label">{label}</legend>
      <ul className="space-y-2">
        {items.map((item, i) => {
          const mine = issuesAt(issues, `${path}.${i}`);
          return (
            <li key={i}>
              <div className="flex gap-2">
                <input
                  aria-label={`${label} ${i + 1}`} className="field" value={item} maxLength={200}
                  aria-invalid={mine.length > 0}
                  onChange={(e) => onChange(items.map((x, j) => (j === i ? e.target.value : x)))}
                />
                <button type="button" className="btn btn-quiet btn-danger" aria-label={`Remove ${label} ${i + 1}`}
                  onClick={() => onChange(items.filter((_, j) => j !== i))}>Remove</button>
              </div>
              {mine.map((m) => <p key={m.message} className="mt-1 text-xs text-danger">{m.message}</p>)}
            </li>
          );
        })}
      </ul>
      <button type="button" className="btn mt-3" disabled={items.length >= max}
        onClick={() => onChange([...items, ""])}>{addLabel}</button>
      {hint ? <p className="hint">{hint}</p> : null}
    </fieldset>
  );
}

export function Toggle({
  label, checked, onChange, hint,
}: { label: string; checked: boolean; onChange: (v: boolean) => void; hint?: string }) {
  const id = useId();
  return (
    <div className="flex items-start gap-3">
      <input id={id} type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)}
        className="mt-1 size-4 accent-[var(--accent)]" />
      <label htmlFor={id} className="text-sm">
        {label}
        {hint ? <span className="hint block">{hint}</span> : null}
      </label>
    </div>
  );
}
