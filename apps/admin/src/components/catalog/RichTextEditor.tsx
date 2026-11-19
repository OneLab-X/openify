"use client";
import { EditorContent, useEditor, useEditorState, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Bold, Heading2, Heading3, Italic, Link2, List, ListOrdered, Quote, Redo2, Underline as UnderlineIcon, Undo2 } from "lucide-react";
import type { ReactNode } from "react";

/**
 * TipTap editor (ported from PLS). Output is limited to what the server's DOMPurify allow-list keeps;
 * the API sanitises again on save and on output.
 */
export function RichTextEditor({ id, labelledBy, value, onChange }: { id: string; labelledBy: string; value: string; onChange: (html: string) => void }) {
  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      StarterKit.configure({
        heading: { levels: [2, 3] },
        code: false,
        codeBlock: false,
        link: { openOnClick: false, autolink: true, defaultProtocol: "https", protocols: ["http", "https", "mailto"] },
      }),
    ],
    content: value,
    editorProps: {
      attributes: {
        id,
        "aria-labelledby": labelledBy,
        role: "textbox",
        "aria-multiline": "true",
        class: "prose prose-sm max-w-none min-h-36 px-3 py-2 focus:outline-none",
      },
    },
    onUpdate: ({ editor: e }) => onChange(e.isEmpty ? "" : e.getHTML().replace(/(<p><\/p>)+$/, "")),
  });
  return (
    <div className="overflow-hidden rounded-md border border-input bg-background focus-within:ring-2 focus-within:ring-ring">
      {editor ? <Toolbar editor={editor} /> : null}
      <EditorContent editor={editor} />
    </div>
  );
}

function Toolbar({ editor }: { editor: Editor }) {
  const s = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive("bold"),
      italic: e.isActive("italic"),
      underline: e.isActive("underline"),
      h2: e.isActive("heading", { level: 2 }),
      h3: e.isActive("heading", { level: 3 }),
      bullet: e.isActive("bulletList"),
      ordered: e.isActive("orderedList"),
      quote: e.isActive("blockquote"),
      link: e.isActive("link"),
      canUndo: e.can().undo(),
      canRedo: e.can().redo(),
    }),
  });
  const setLink = () => {
    const previous = editor.getAttributes("link").href as string | undefined;
    const url = window.prompt("Link address (leave empty to remove)", previous ?? "https://");
    if (url === null) return;
    if (url.trim() === "" || url.trim() === "https://") editor.chain().focus().extendMarkRange("link").unsetLink().run();
    else editor.chain().focus().extendMarkRange("link").setLink({ href: url.trim() }).run();
  };
  const run = (fn: (c: ReturnType<Editor["chain"]>) => ReturnType<Editor["chain"]>) => () => fn(editor.chain().focus()).run();
  return (
    <div role="toolbar" aria-label="Formatting" className="flex flex-wrap items-center gap-0.5 border-b border-border bg-muted px-2 py-1">
      <Tool label="Bold" active={s.bold} onClick={run((c) => c.toggleBold())}><Bold /></Tool>
      <Tool label="Italic" active={s.italic} onClick={run((c) => c.toggleItalic())}><Italic /></Tool>
      <Tool label="Underline" active={s.underline} onClick={run((c) => c.toggleUnderline())}><UnderlineIcon /></Tool>
      <Tool label="Heading" active={s.h2} onClick={run((c) => c.toggleHeading({ level: 2 }))}><Heading2 /></Tool>
      <Tool label="Subheading" active={s.h3} onClick={run((c) => c.toggleHeading({ level: 3 }))}><Heading3 /></Tool>
      <Tool label="Bullet list" active={s.bullet} onClick={run((c) => c.toggleBulletList())}><List /></Tool>
      <Tool label="Numbered list" active={s.ordered} onClick={run((c) => c.toggleOrderedList())}><ListOrdered /></Tool>
      <Tool label="Quote" active={s.quote} onClick={run((c) => c.toggleBlockquote())}><Quote /></Tool>
      <Tool label="Link" active={s.link} onClick={setLink}><Link2 /></Tool>
      <Tool label="Undo" disabled={!s.canUndo} onClick={run((c) => c.undo())}><Undo2 /></Tool>
      <Tool label="Redo" disabled={!s.canRedo} onClick={run((c) => c.redo())}><Redo2 /></Tool>
    </div>
  );
}

function Tool({ label, active = false, disabled = false, onClick, children }: { label: string; active?: boolean; disabled?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      aria-pressed={active}
      title={label}
      className="rounded p-1.5 hover:bg-background disabled:opacity-40 aria-pressed:bg-background [&_svg]:h-4 [&_svg]:w-4"
    >
      {children}
    </button>
  );
}
