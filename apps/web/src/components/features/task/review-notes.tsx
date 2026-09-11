"use client";

import type { ReviewNote } from "@solow/contracts";
import { MessageSquare, Pencil, Trash2 } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

/**
 * Where a note attaches: one line, on one side of the diff. The new side when the row has one —
 * that is the file that will exist — and the old side only for a deletion, which has no other.
 */
export interface LineAnchor {
  side: "old" | "new";
  line: number;
}

/**
 * The reviewer's notes on one file, and the three things the editor can do with them.
 *
 * Held by the workspace's review draft (`useReviewDraft`) — persisted per user, per round — and
 * handed to the editor for the one file it is showing. The editor never sees another file's
 * notes, so it cannot draw them on the wrong lines.
 */
export interface ReviewNotes {
  /** This file's notes only. */
  notes: readonly ReviewNote[];
  onAdd: (anchor: LineAnchor, text: string) => void;
  onEdit: (note: ReviewNote, text: string) => void;
  onRemove: (note: ReviewNote) => void;
}

/**
 * What hangs under a diff row (spec F10 FR-7): the notes already on that line, and the form for
 * another. The form is a small textarea with Save and Cancel, ⌘↩ saving and Escape cancelling —
 * the keys the composer under the terminal already uses, so a reviewer learns them once.
 *
 * Notes are the reviewer's own draft until "Request changes" sends them, and the thread says
 * nothing about that itself: the gate does, next to the button that sends them.
 */
export function ReviewNoteThread({
  anchor,
  notes,
  composing,
  onCompose,
  onSave,
  onEdit,
  onRemove,
}: {
  anchor: LineAnchor;
  notes: readonly ReviewNote[];
  composing: boolean;
  onCompose: (open: boolean) => void;
  onSave: (text: string) => void;
  onEdit: (note: ReviewNote, text: string) => void;
  onRemove: (note: ReviewNote) => void;
}) {
  return (
    <div
      className="border-y bg-background/60 px-3 py-1.5 font-sans"
      data-review-thread={`${anchor.side}:${anchor.line}`}
    >
      {notes.map((note, index) => (
        <SavedNote
          // A line can carry more than one note; position within the line is the only identity.
          // biome-ignore lint/suspicious/noArrayIndexKey: see above
          key={index}
          note={note}
          onEdit={(text) => onEdit(note, text)}
          onRemove={() => onRemove(note)}
        />
      ))}
      {composing ? (
        <NoteForm
          initial=""
          placeholder={`A note on line ${anchor.line}…`}
          onSave={(text) => {
            onSave(text);
            onCompose(false);
          }}
          onCancel={() => onCompose(false)}
        />
      ) : null}
    </div>
  );
}

function SavedNote({
  note,
  onEdit,
  onRemove,
}: {
  note: ReviewNote;
  onEdit: (text: string) => void;
  onRemove: () => void;
}) {
  const [editing, setEditing] = useState(false);
  if (editing) {
    return (
      <NoteForm
        initial={note.text}
        placeholder=""
        onSave={(text) => {
          onEdit(text);
          setEditing(false);
        }}
        onCancel={() => setEditing(false)}
      />
    );
  }
  return (
    <div className="group/note flex items-start gap-2 py-1 text-xs" data-review-note>
      <MessageSquare aria-hidden className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
      <p className="min-w-0 flex-1 whitespace-pre-wrap break-words">{note.text}</p>
      <span className="flex shrink-0 items-center opacity-0 transition-opacity focus-within:opacity-100 group-hover/note:opacity-100">
        <Button
          aria-label="Edit note"
          size="icon-xs"
          variant="ghost"
          onClick={() => setEditing(true)}
        >
          <Pencil />
        </Button>
        <Button
          aria-label="Delete note"
          size="icon-xs"
          variant="ghost"
          className="text-muted-foreground hover:text-destructive"
          onClick={onRemove}
        >
          <Trash2 />
        </Button>
      </span>
    </div>
  );
}

function NoteForm({
  initial,
  placeholder,
  onSave,
  onCancel,
}: {
  initial: string;
  placeholder: string;
  onSave: (text: string) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState(initial);
  const save = () => {
    const trimmed = text.trim();
    if (trimmed) onSave(trimmed);
  };
  return (
    <form
      className="space-y-1.5 py-1"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <Textarea
        // The form appears where the reviewer just clicked, and the whole point is to type into it.
        autoFocus
        aria-label="Note"
        rows={2}
        value={text}
        placeholder={placeholder}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            save();
          }
        }}
        className="min-h-14 text-xs"
      />
      <div className="flex justify-end gap-1.5">
        <Button type="button" size="xs" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" size="xs" disabled={!text.trim()}>
          Save note
        </Button>
      </div>
    </form>
  );
}
