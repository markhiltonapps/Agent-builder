"use client";

import { useId, useState } from "react";
import type { ValidationIssue } from "@/lib/config";

export type Issues = ValidationIssue[];

/** Messages for exactly this path (not its children). */
export const issuesAt = (issues: Issues, path: string) => issues.filter((i) => i.path === path);

/** Ids that tie an input to its hint and error messages. */
function ids(id: string, errors: number, hasHint: boolean) {
  const errIds = Array.from({ length: errors }, (_, i) => `${id}-err-${i}`);
  const hintId = hasHint ? `${id}-hint` : undefined;
  return { errIds, hintId, describedBy: [...errIds, ...(hintId && !errors ? [hintId] : [])].join(" ") || undefined };
}

function Shell({
  label, hint, issues, id, children,
}: { label: string; hint?: string; issues: Issues; id: string; children: React.ReactNode }) {
  const { errIds, hintId } = ids(id, issues.length, Boolean(hint));
  return (
    <div>
      <label className="label" htmlFor={id}>{label}</label>
      {children}
      {issues.map((i, n) => (
        <p key={i.message} id={errIds[n]} className="mt-1 text-xs text-danger">{i.message}</p>
      ))}
      {hint && !issues.length ? <p id={hintId} className="hint">{hint}</p> : null}
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
  const { describedBy } = ids(id, mine.length, Boolean(hint));
  return (
    <Shell label={label} hint={hint} issues={mine} id={id}>
      <input
        id={id} className="field" value={value} maxLength={maxLength} placeholder={placeholder}
        aria-invalid={mine.length > 0 || undefined} aria-describedby={describedBy}
        onChange={(e) => onChange(e.target.value)}
      />
    </Shell>
  );
}

/**
 * A short list typed as "en, es". The text is kept as typed and only turned into a list when
 * the person leaves the field, so a trailing comma is not eaten while they type.
 */
export function CsvField({
  label, values, onCommit, path, issues = [], hint,
}: {
  label: string; values: string[]; onCommit: (v: string[]) => void; path: string; issues?: Issues; hint?: string;
}) {
  const id = useId();
  const mine = issuesAt(issues, path);
  const { describedBy } = ids(id, mine.length, Boolean(hint));
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <Shell label={label} hint={hint} issues={mine} id={id}>
      <input
        id={id} className="field" value={draft ?? values.join(", ")}
        aria-invalid={mine.length > 0 || undefined} aria-describedby={describedBy}
        onChange={(e) => {
          setDraft(e.target.value);
          onCommit(e.target.value.split(",").map((s) => s.trim()).filter(Boolean));
        }}
        onBlur={() => setDraft(null)}
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
  const { describedBy } = ids(id, mine.length, Boolean(hint));
  return (
    <Shell label={label} hint={hint} issues={mine} id={id}>
      <textarea
        id={id} rows={rows} maxLength={maxLength} value={value}
        className={`field ${mono ? "font-mono text-[0.82rem]" : ""}`}
        aria-invalid={mine.length > 0 || undefined} aria-describedby={describedBy}
        onChange={(e) => onChange(e.target.value)}
      />
    </Shell>
  );
}

export function SelectField<T extends string>({
  label, value, onChange, options, hint,
}: {
  label: string; value: T; onChange: (v: T) => void; options: { value: T; label: string }[]; hint?: string;
}) {
  const id = useId();
  const { describedBy } = ids(id, 0, Boolean(hint));
  return (
    <Shell label={label} hint={hint} issues={[]} id={id}>
      <select id={id} className="field" value={value} aria-describedby={describedBy} onChange={(e) => onChange(e.target.value as T)}>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </Shell>
  );
}

/** A number typed as text and committed when valid, so the box can be emptied while typing. */
export function NumberField({
  label, value, onChange, min, max, hint, path, issues = [],
}: {
  label: string; value: number; onChange: (v: number) => void; min: number; max: number;
  hint?: string; path: string; issues?: Issues;
}) {
  const id = useId();
  const mine = issuesAt(issues, path);
  const { describedBy } = ids(id, mine.length, Boolean(hint));
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <Shell label={label} hint={hint} issues={mine} id={id}>
      <input
        id={id} inputMode="numeric" className="field" value={draft ?? String(value)}
        aria-invalid={mine.length > 0 || undefined} aria-describedby={describedBy}
        onChange={(e) => {
          const text = e.target.value.replace(/[^\d]/g, "");
          setDraft(text);
          if (text !== "") onChange(Number(text));
        }}
        onBlur={() => setDraft(null)}
        aria-label={`${label}, ${min} to ${max}`}
      />
    </Shell>
  );
}

/** An ordered list of one-line strings (rules). */
export function StringList({
  label, items, onChange, path, issues = [], addLabel, max, hint, itemName,
}: {
  label: string; items: string[]; onChange: (v: string[]) => void; path: string;
  issues?: Issues; addLabel: string; max: number; hint?: string; itemName: string;
}) {
  const base = useId();
  return (
    <fieldset>
      <legend className="label">{label}</legend>
      {hint ? <p id={`${base}-hint`} className="hint mb-3 mt-0">{hint}</p> : null}
      {items.length === 0 && <p className="mb-3 text-sm text-muted">None yet. Add one below.</p>}
      <ul className="space-y-2">
        {items.map((item, i) => {
          const mine = issuesAt(issues, `${path}.${i}`);
          const errIds = mine.map((_, n) => `${base}-${i}-err-${n}`);
          return (
            <li key={i}>
              <div className="flex gap-2">
                <input
                  aria-label={`${itemName} ${i + 1}`} className="field" value={item} maxLength={200}
                  aria-invalid={mine.length > 0 || undefined} aria-describedby={errIds.join(" ") || undefined}
                  onChange={(e) => onChange(items.map((x, j) => (j === i ? e.target.value : x)))}
                />
                <button type="button" className="btn btn-quiet btn-danger shrink-0" aria-label={`Remove ${itemName.toLowerCase()} ${i + 1}`}
                  onClick={() => onChange(items.filter((_, j) => j !== i))}>Remove</button>
              </div>
              {mine.map((m, n) => <p key={m.message} id={errIds[n]} className="mt-1 text-xs text-danger">{m.message}</p>)}
            </li>
          );
        })}
      </ul>
      <button type="button" className="btn mt-3" disabled={items.length >= max}
        onClick={() => onChange([...items, ""])}>{addLabel}</button>
    </fieldset>
  );
}

export function Toggle({
  label, checked, onChange, hint,
}: { label: string; checked: boolean; onChange: (v: boolean) => void; hint?: string }) {
  const id = useId();
  return (
    <label htmlFor={id} className="flex cursor-pointer items-start gap-3 rounded-lg py-1 text-sm">
      <input id={id} type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="mt-0.5 size-5 shrink-0" />
      <span>
        {label}
        {hint ? <span className="hint block">{hint}</span> : null}
      </span>
    </label>
  );
}
