"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import { addMedia, type AddState } from "@/app/actions";
import { btn, input } from "@/components/ui";

export default function AddLinkForm() {
  const [state, action, pending] = useActionState<AddState, FormData>(addMedia, {});
  const [more, setMore] = useState(false);

  return (
    <form action={action} className="rounded-2xl border border-white/10 bg-gradient-to-br from-violet-500/10 to-cyan-400/5 p-5">
      <div className="flex flex-col gap-3 sm:flex-row">
        <input
          name="url"
          required
          placeholder="Paste a YouTube, Facebook, Instagram, X, TikTok or image link…"
          className={input}
          autoComplete="off"
        />
        <button type="submit" disabled={pending} className={`${btn} sm:w-44`}>
          {pending ? "Analyzing…" : "Fetch & analyze"}
        </button>
      </div>
      <button type="button" onClick={() => setMore((v) => !v)} className="mt-3 text-xs text-slate-400 hover:text-slate-200">
        {more ? "− Hide" : "+ Add"} manual details (optional)
      </button>
      {more && (
        <div className="mt-3 grid gap-3 sm:grid-cols-4">
          <input name="title" placeholder="Title" className={input} />
          <input name="creator" placeholder="Creator" className={input} />
          <input name="date" type="date" className={input} />
          <input name="tags" placeholder="tags, comma, separated" className={input} />
        </div>
      )}
      {state.error && (
        <p className="mt-3 text-sm text-rose-300">
          {state.error}{" "}
          {state.id && (
            <Link href={`/media/${state.id}`} className="underline">
              Open it
            </Link>
          )}
        </p>
      )}
      {state.ok && (
        <p className="mt-3 text-sm text-emerald-300">
          {state.ok}.{" "}
          {state.id && (
            <Link href={`/media/${state.id}`} className="underline">
              View details
            </Link>
          )}
        </p>
      )}
    </form>
  );
}
