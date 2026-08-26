# n8n-nodes-docmint

Fill **Word, Excel and PowerPoint templates** with data from your workflow and get the
file — or a PDF, or both — back on the same node.

And the part nothing else does: **the node reads your template and turns its
placeholders into real n8n fields.** Typed, expression-capable, one per placeholder,
with the names taken from the document itself. No JSON textarea. No guessing the keys.

[DocMint](https://docmint.app.mintapis.com) is the API behind it.

---

## Why this node exists

Every document-generation product joins your data to your template by invisible string
matching, and none of them will tell you the field names before you render. So the loop
you are in today is:

> guess the keys → render → open the .docx in Word → find the silently-empty cell → guess again

This node breaks that loop in two places.

**1. It shows you the placeholders.** DocMint has `GET /v1/templates/:name/fields`, and the
node wires it to n8n's resource mapper. Pick a template and the panel fills with the
placeholders that template actually contains — `invoice_no`, `customer.name`, `issued`,
`items` — each as its own input, with the right widget: `{issued|date:...}` is a date
field, `{total|currency:EUR}` a number field, `{#items}` a list.

The node guesses none of that. DocMint works the types out by **actually rendering the
template**, so what the form shows cannot drift from what a real render would do. Fields
written inside a `{#section}` are not offered at the top level — they belong to a row —
and the list field's label says what each row needs: `items (rows: description, qty,
unit_price)`. A list inside a list is marked `orders (rows: ref, customer, lines[])`.

**2. It refuses to render a document with a hole in it.** If a placeholder has no value,
DocMint answers 422 and names the placeholder *and where in the document it is*. The node
puts both in the red box in n8n:

> **The template uses {customer_vat} but the data has no "customer_vat".**
> Placeholder "customer_vat", at word/document.xml, paragraph 12. Did you mean
> "customer_vat_id"? Fields the template can see here: invoice_no, customer_vat_id,
> total. Open the Data section: the placeholder named above is one of the fields
> listed there.

You never open Word to find out what went wrong.

If you already have a data object upstream, turn on **Send Raw JSON Instead** and pass it
through. The mapper is the default; the JSON blob is the escape hatch.

## Install

> **Unverified community nodes need self-hosted n8n.** n8n's rule is that *"unverified
> community nodes aren't available on n8n cloud and require self-hosting n8n."* Until this
> package is verified, install it on a self-hosted instance. On n8n Cloud you can call the
> API directly from an HTTP Request node pointed at `POST /v1/render`, which returns the
> same bytes this node hands you.

**From the n8n UI**

Settings → Community Nodes → Install → `n8n-nodes-docmint`

**From the CLI**

```bash
cd ~/.n8n/nodes
npm install n8n-nodes-docmint
```

Then restart n8n.

The package is published from
[this repository's GitHub Actions workflow](.github/workflows/publish.yml) with an npm
provenance attestation, so `npm audit signatures` can verify which commit built it.

## Credential

1. Create an account at <https://docmint.app.mintapis.com/signup>. Your API key is shown
   once, immediately.
2. In n8n, add a **DocMint API** credential and paste the key. It starts with `dm_live_`.
3. Press **Test**. The credential checks itself against `GET /v1/usage`, which is
   authenticated, costs no credits and creates no file.

**Base URL** only needs changing if you run your own DocMint instance.

## Zero to a filled invoice

You need one thing to start: a `.docx` with placeholders in it. Open Word, type this, save
it as `invoice.docx`:

```
INVOICE {invoice_no}
Date: {issued|date:DD MMMM YYYY}

Bill to: {customer.name}
{customer.address}

{#items}
{description}   {qty} x {unit_price|currency:EUR} = {line_total|currency:EUR}
{/items}

Total: {items|sumProduct:qty:unit_price|currency:EUR}
```

**Step 1 — upload it once.**

Add a **DocMint** node, set **Resource** to `Template` and **Operation** to `Upload`.
Point **Input Binary Field** at the property holding the file (`data` if a Read/Write
Files node put it there) and set **Name** to `invoice`. Execute it once. The response
tells you the format it detected and lists the placeholders it found.

You never have to do this again — uploading the same name later adds a *version* rather
than replacing the file, and old versions can be rolled back.

**Step 2 — fill it.**

Add a second **DocMint** node after whatever produces your data. Leave **Resource** on
`Document` and **Operation** on `Fill`, then open the **Template** dropdown and choose
`invoice`.

The **Data** section now lists the placeholders the document actually contains. Fill them
in, or drop an expression into each:

| Placeholder | Value |
|---|---|
| `invoice_no` | `{{ $json.number }}` |
| `issued` | `{{ $now }}` |
| `customer.name` | `{{ $json.customer }}` |
| `customer.address` | `{{ $json.address }}` |
| `items (rows: description, qty, unit_price)` | `{{ $json.lines }}` |

Set **File Name** to `invoice-{invoice_no}` and execute.

The output item carries the filled `.docx` in the `data` binary field, named
`invoice-INV-2026-0001.docx`, ready for Gmail, Drive, S3, Slack or an HTTP Request. No
second download step.

Prefer the whole item mapped automatically? Switch the Data section's mode to **Map
Automatically** and the incoming item's JSON is sent as the data.

## Operations

### Document

| Operation | What it does |
|---|---|
| **Fill** | Fill a template with data and return the document, a PDF, or both |
| **Inspect** | List the placeholders a template contains, and where each one is written |

**Inspect** is worth wiring up on its own. Point it at a template and execute. The output
item carries:

- `fields` — the typed, scoped tree: every placeholder with its `type`, the `scope` it
  lives in, whether it `repeating`s, whether it is `required`, how often it is `used`, and
  the `locations` it appears at.
- `tags` — what is literally written in the file, with the `location` of each
  (`word/document.xml, paragraph 12`, `Sheet1!C7`, `slide 3, shape "Title"`).
- `sample_data` — a skeleton payload DocMint built by rendering the template.

`sample_data` is the shortcut. Wire Inspect into a Fill node, turn on **Send Raw JSON
Instead**, and pass `{{ $json.sample_data }}`: you get a real document out of an unfamiliar
template in one step, then replace the dummy values one at a time.

That the skeleton actually renders is a test, not a hope: DocMint's suite fills every one
of its 21 fixture and example templates with the `sample_data` its own API returned for
them, and all 21 succeed. It was 20 until the case that failed was fixed — a template
multiplying two fields that nothing else typed as numbers, where the skeleton offered text
and `sumProduct` rightly refused it. Formatter arguments are now read as type facts, so
`{items|sumProduct:qty:unit_price}` makes `qty` a number even though no other tag says so.

### Template

| Operation | What it does |
|---|---|
| **Upload** | Upload a `.docx`, `.xlsx` or `.pptx` from a binary field, or add a version to an existing template |
| **Get** | One template: format, size, current version and its version history |
| **Get Many** | The templates on the account |
| **Get Fields** | The placeholders a stored template needs |
| **Download** | The template file itself, as binary |
| **Delete** | Delete a template and every version of it |
| **List Versions** | Every stored version, with size, note and date |
| **Rollback** | Restore an earlier version as the current one |

### Account

| Operation | What it does |
|---|---|
| **Get Usage** | Plan, quota, documents remaining, and this month's breakdown |

The node is marked `usableAsTool`, so an **n8n AI Agent can call it directly** — give the
agent the node and it can produce a document as part of its own reasoning.

## Choosing the template

The **Template** field has three modes:

- **From List** — a searchable dropdown of the templates on your account, each showing its
  format and how many placeholders it has.
- **By Name** — plain text, so an expression can pick the template at runtime:
  `{{ $json.docType }}`.
- **Upload / Inline** — the name of a binary field on the item holding the template file.
  It is sent with the request and nothing is stored on your account. Useful when the
  template itself comes from Drive or an email attachment.

In **Upload / Inline** mode the placeholders are only known once the workflow runs, so the
Data section cannot list them in advance. It says so, and points you at **Send Raw JSON
Instead** or at the **Inspect** operation.

## Office file, PDF, or both

**Output** is a per-request choice, not a property of the template.

| Output | You get |
|---|---|
| **Office File** (default) | The filled `.docx`, `.xlsx` or `.pptx`, in the `data` binary field |
| **PDF** | The document converted to PDF, in the `data` binary field |
| **Both** | Two binary fields on one item: the Office file in `data` and the PDF in `pdf` |

With **Both**, the item's JSON also carries `binaryFields: { document: "data", pdf: "pdf" }`,
so the next node does not have to guess where they went. Both field names are configurable
under **Options**.

A PDF costs one credit more than the Office file, because converting it costs DocMint
about a hundred times the CPU of the fill itself (measured: roughly 1.0 s of LibreOffice
against about 10 ms). Nothing else is metered — downloading a file you already generated
is free.

## Template syntax

Both delimiter styles work, in every format, always: `{name}` and `{{name}}`. A template
written for docxtemplater and one written for a Handlebars-based tool both work unchanged.

| Form | Meaning |
|---|---|
| `{name}` | a value |
| `{user.email}`, `{items.0.sku}` | dotted path, numeric index |
| `{{[Customer Name]}}` | a field name containing spaces |
| `{#items} … {/items}` | section: once per array element; once for an object; once for a truthy scalar; never for an empty array |
| `{^items} … {/items}` | inverted section: renders only when absent, empty or falsy |
| `{/}` | closes the innermost open section |
| `{.}` | the current item, for arrays of scalars |
| `{../x}` | one scope outwards |
| `{$index}` `{$index1}` `{$first}` `{$last}` `{$length}` | loop metadata |
| `{%logo}` | an image, from a URL or base64 |
| `{@rawXml}` | raw OOXML, unescaped |
| `{!note}` | a comment, removed from the output |
| `{price\|currency:EUR}` | a formatter pipeline |

Anything between braces that does not parse as a tag is left alone, so a document
containing `{ "total": 12 }` or `.a { color: red }` renders unchanged.

**Formatters:**
`add` `count` `currency` `date` `default` `divide` `filter` `groupBy` `join` `limit`
`lower` `multiply` `number` `ordinal` `percent` `reject` `reverse` `round` `skip` `sort`
`subtract` `sum` `sumProduct` `title` `trim` `unique` `upper` `yesno`

`{items|sum:amount}` and `{items|sumProduct:qty:price}` are the ones that matter: a total
in a document should be computed from the data, never typed in. Formatters work on
sections too — `{#items|filter:active|sort:due_date}` — so the workflow does not have to
pre-sort a list before it gets here.

The live list for your deployment is at
<https://docmint.app.mintapis.com/v1/capabilities>, which is generated from the running
code rather than written by hand.

## Options

Everything below is optional and lives under **Options** on the Fill operation.

| Option | Default | Notes |
|---|---|---|
| Locale | `en-US` | BCP 47 tag deciding how numbers, dates and currencies are written |
| Currency | `USD` | Three-letter ISO code used by `currency` when the template names none |
| Time Zone | `UTC` | IANA zone the `date` formatter renders in |
| On Missing Placeholder | Fail and name it | Or leave empty, or keep the tag visible for debugging |
| Strict Scope | off | Fail when a placeholder inside a loop is not a field of the row |
| Template Version | current | Render an older version of a stored template |
| Put Office File in Field | `data` | Binary field name |
| Put PDF in Field | `pdf` | Binary field name, used when Output is Both |

### Strict Scope, and the bug it catches

Write `{#items}{name}{/items}` where `name` exists only at the top level of your data and
most document generators will happily print the same value on every row and tell you
nothing. DocMint allows it — `{currency}` from the invoice root *should* resolve inside a
loop — but reports every occurrence back as a `resolved_from_outer_scope` warning naming
the placeholder, the location, and the fields the row actually has. Turn **Strict Scope**
on and it becomes an error instead.

## Errors

The API answers every failure with a machine code, a sentence, a hint, and — for a
placeholder that would not resolve — the field name and its location in the document. The
node puts the sentence in the error title and everything else in the description.

Turn on **Settings → Continue On Fail** to route bad items down the error branch instead.
The failed item carries the API's own fields, so an IF node can branch on
`$json.error.code`, `$json.error.field` or `$json.error.location`:

```json
{
  "error": {
    "code": "placeholder_unresolved",
    "message": "The template uses {customer_vat} but the data has no \"customer_vat\".",
    "hint": "Did you mean \"customer_vat_id\"? …",
    "field": "customer_vat",
    "location": "word/document.xml, paragraph 12",
    "available": ["invoice_no", "customer_vat_id", "total"],
    "docs": "https://docmint.app.mintapis.com/docs#errors",
    "request_id": "51e5390e4107f566",
    "httpCode": "422"
  },
  "errorMessage": "The template uses {customer_vat} but the data has no \"customer_vat\"."
}
```

`rate_limited` (429), `pdf_queue_full` (503) and `pdf_timeout` (504) are all worth
retrying — turn on **Settings → Retry On Fail** and n8n handles them.

A credit taken for a render that then fails is refunded, so a run that errors on a missing
field costs you nothing.

## Limits

| | |
|---|---|
| Formats filled | `.docx`, `.xlsx`, `.pptx` |
| Max template | 25 MB |
| Max data | 8 MB |
| Max request body | 36 MB |
| Versions kept per template | 20, oldest pruned first, never below one |
| PDF conversion timeout | 90 s |
| Requests per minute, per account | 120, with a burst of 30 |

Template names are 1–64 characters of lower-case letters, digits, dot, dash and
underscore. Macro-enabled files (`.docm`, `.xlsm`, `.pptm`) are filled, but the macros are
not guaranteed to survive and the file comes back with the plain content type — the render
response says so in its warnings.

## Pricing

| Plan | Price | Documents / month |
|---|---|---|
| Free | $0 | 30 |
| Starter | $9 | 2,000 |
| Pro | $29 | 20,000 |
| Scale | $99 | 100,000 |

A document costs one credit; asking for a PDF costs one more. Nothing else is metered.

For scale: Docupilot's published Starter plan is $29/month for 100 documents, and it bills
per *delivery* — "if you generate an invoice and send it via email to recipients while also
uploading it to Google Drive, it will use 2 credits", and "Downloading generated document
also consumes 1 credit". DocMint bills once per document produced.

## What DocMint does not do

Stated plainly, because a README that only lists strengths is not much use:

- **No richtext, QR codes or maps.** HTML or Markdown into a Word document is not
  supported. Docupilot has all three.
- **LibreOffice only** for the PDF step. No PDF/A, no watermarking, no PDF encryption, no
  choice of converter. Carbone offers all of those.
- **A smaller formatter library than Carbone's**, which also has aggregates
  (`aggSum`, `cumSum`), an i18n system, live currency conversion and block operators
  (`drop`/`keep`). DocMint has 43 formatters including value and date comparisons; Carbone
  has more.
- **One error per render.** If two placeholders are wrong, DocMint names the first,
  you fix it, and the next render names the second. docxtemplater reports them all at once.
- **No batch or asynchronous rendering yet, and PDF conversion runs one at a time.**
  LibreOffice was measured at 219 MB peak and about 2.6 seconds per conversion on the
  production instance, so PDF requests queue. If you need hundreds of PDFs at once, that is
  a real limitation today; ask for the Office file instead, which is not throttled and
  takes about 25 ms end to end.
- **No delivery integrations.** DocMint returns the file and lets n8n do the emailing,
  uploading and storing — which is the right split for a workflow tool, but it is a
  difference rather than a strict advantage.
- **Types are as good as the template is explicit.** A field only DocMint's formatters
  describe gets described well: `{total|currency:EUR}` is a number, `{issued|date:...}` a
  date. A bare `{qty}` is text, even where the template later multiplies it, so the form
  offers a text box and the arithmetic is checked at render time instead.
- **Against a DocMint older than the typed field tree** — an out-of-date self-hosted
  instance — the node falls back to listing every placeholder as text at the top level,
  with no types and no row grouping. It does not guess to fill the gap.

## Links

- Docs: <https://docmint.app.mintapis.com/docs>
- Dashboard: <https://docmint.app.mintapis.com/dashboard>
- Capabilities of the running build: <https://docmint.app.mintapis.com/v1/capabilities>
- Issues: <https://github.com/fstandhartinger/n8n-nodes-docmint/issues>

Generating PDFs from HTML, Markdown or a URL instead? That is
[n8n-nodes-pdfmint](https://www.npmjs.com/package/n8n-nodes-pdfmint), by the same author.

## Compatibility

Built and tested against `n8n-workflow` 2.35.3 on Node.js 20. The `engines` field asks for
Node 20.15 or newer, matching n8n's own floor. The package has **zero runtime
dependencies** — it is a thin HTTP client, which is what makes it eligible for n8n
verification at all.

## Licence

[MIT](LICENSE.md)

## Verification video, submitted 2026-08-25

`manual:under-review` — the demo video is uploaded and n8n's team has it.

Recorded against n8n's own checklist, read off the portal rather than guessed:
install from npm (0.1.0, the submitted version), new workflow, credential **with
the connection test shown passing**, the common action, and the node used as an
AI-agent tool. 3.9 minutes, no cuts — Playwright records the browser context, so
the file is continuous by construction.

`recorder/` holds the script. Nine takes; each failure is worth knowing:

| Take | What broke |
| --- | --- |
| 1 | the risks checkbox never ticked, so Install stayed disabled — the step now asserts the button became enabled instead of assuming the click landed |
| 2 | `text=` mixed into a CSS selector list; Playwright syntax cannot be |
| 3 | the action is "Fill document template", not "Fill" |
| 4 | the credential button reads "Connect to DocMint" in this n8n build |
| 5–6 | the template dropdown items are not `el-select-dropdown__item`; matched on text instead |
| 7 | the chat-model handle was picked by DOM order, which includes the agent's main output handle — the agent then errored "A Chat Model sub-node must be connected" |
| 8 | the agent asked a clarifying question instead of calling the tool: the prompt left the output format open |
| 9 | the expression editor auto-closes braces, so a typed `}}` produced `}} }}` |

**One thing the video does not claim.** `$fromAI` reached the tool but never
carried the field values, and DocMint correctly refused a fill with no data. The
tool's data is therefore pinned, and the agent decides *when* to call it — which
is what n8n asks to see. The caption says exactly that and no more.
