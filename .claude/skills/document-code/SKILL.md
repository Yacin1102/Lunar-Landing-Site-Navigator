---
name: document-code
description: Documentation standard for code in this repository and how to keep docs/ARCHITECTURE.md in sync. Use whenever writing or changing code.
---

The reviewer does not write code and has no strong astronomy background, so documentation must let them follow what the code does and why.

- Every module, class and function has a docstring: its role, how it works in plain words, and arguments and return values **with units**. Mention the spec section it implements. Any examples in docstrings must be correct (run them as doctests if you include them).
- `docs/ARCHITECTURE.md` describes the code as built, not as planned: a module table (job, reads, writes) and Mermaid diagrams of the structure and the data flow. Add other pages in `docs/` when they help a reader.
- Do not copy the spec into `docs/`.
