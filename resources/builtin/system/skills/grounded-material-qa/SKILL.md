---
name: grounded-material-qa
description: Answer questions strictly from the user's imported materials — Library files, conversation attachments, space artifacts — never from memory or the web. Retrieves evidence with ask_materials / material_search, answers only from cited evidence (`path#chunk N`), and says plainly when the material set does not contain the answer. Use for "根据资料", "这个文件/文档里", "资料里有没有…", grounded Q&A on uploaded documents, and any question scoped to imported materials. Do not use for general-knowledge, time-sensitive-web, or personal-memory questions.
---

# Grounded Material Q&A

Answer user questions **within the material set boundary**: retrieve evidence
from imported materials first, answer only from that evidence with citations,
and explicitly say when the materials do not contain the answer — never
fabricate and never silently switch to web search.

## use_when

- User asks about the content of a Library file, a conversation attachment, or
  a space artifact: "根据这份资料…", "这个文档里讲了什么", "资料里有没有提到 X".
- User asks a factual question that is plausibly answerable from uploaded
  materials (course notes, PDFs, meeting transcripts, reports).
- User asks to summarize or compare material content.
- User asks whether some concept/term appears in the materials.

## do_not_use_when / negative_examples

- General knowledge questions with no material scope ("什么是光合作用？") —
  answer directly, optionally noting it is background knowledge.
- Time-sensitive questions ("今天股价") — web search rules apply, not materials.
- Questions about the user's own memory or conversation history.
- Any question when the user explicitly asks for web/online answers.

## Workflow

1. **Retrieve**: call `ask_materials` with the user's question (it already
   covers Library + this conversation's attachments). If `ask_materials` is
   unavailable or returns weak results, fall back to `material_search` and read
   promising hits with `kb_read`.
2. **Judge the evidence**:
   - Evidence ready → answer **only** from the returned hits. Cite every
     material-derived claim as `path#chunk N` (e.g. `AST.pdf#chunk 12`); do not
     add details the hits do not contain.
   - `no_material` → say plainly: the material set does not contain this;
     name the scope searched (Library / attachments). Do not fabricate, do not
     switch to web search unless the user explicitly asks.
   - `low_confidence` → answer with an explicit caveat, or say no relevant
     material exists.
3. **Verify (when useful)**: for important answers, re-check that every cited
   anchor exists in the retrieved evidence before finalizing; drop or rewrite
   any claim whose citation cannot be confirmed.

## Citation format

- Library hit: `path#chunk N` (path is the Library-relative path).
- Attachment hit: `filename#chunk 0`.
- Never invent a `path#chunk N` that was not returned by retrieval — a citation
  that does not exist in the evidence is a hallucination, not a source.

## Notes

- Read-only: this skill never writes, edits, uploads, or sends anything.
- Materials are scoped to the current conversation/space; content outside that
  boundary is not evidence.
