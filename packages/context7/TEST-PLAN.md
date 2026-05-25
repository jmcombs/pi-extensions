# Context7 Auth Persistence Investigation Test Plan

**Goal**: Make "Save permanently" from inside tool ad-hoc prompts reliably write to `auth.json` using the official `AuthStorage` API (no manual FS writes). The flow must work consistently from both `/context7_onboard` and from tool prompts.

**Rules**

- Always start with a fresh `pi -e ./packages/context7` session after any code change.
- Start each major scenario with **no** `context7` key in `~/.pi/agent/auth.json` (see cleanup command below).
- Use the file-based diagnostics at `~/.pi/context7-debug.log` (root of `~/.pi`) for visibility.
- All changes must pass `npm run check`.

**Cleanup command (run before most tests)**

```bash
node -e '
  const fs = require("fs");
  const p = process.env.HOME + "/.pi/agent/auth.json";
  const a = JSON.parse(fs.readFileSync(p, "utf8"));
  delete a.context7;
  fs.writeFileSync(p, JSON.stringify(a, null, 2));
  console.log("context7 key removed");
'
```

**Clear diagnostics log**

```bash
rm -f ~/.pi/context7-debug.log
```

---

## Step 1: Instance Sharing & Visibility of set() (Current Focus)

**Purpose**: Prove whether repeated `AuthStorage.create()` calls share state, and whether `set()` from tool paths is visible to fresh instances (and to the next `getApiKey` call).

**Commands to run before starting the session**

```bash
# Clean state
rm -f ~/.pi/context7-debug.log
# Remove any existing key (see cleanup command above)
```

**Start fresh session**

```bash
pi -e ./packages/context7
```

### 1a. Onboard command path (known working baseline)

**Prompt to paste:**

```
Run /context7_onboard and when asked, enter a test key (e.g. ABC_TEST_ONBOARD). Choose to overwrite if prompted.
```

**Expected log lines** (in `~/.pi/context7-debug.log`):

- `onboard pre: sharedHas=... freshHas=...`
- `onboard post-set: errs=0 sharedHas=true freshHas=true`

**Verify after**:

- Key appears in `auth.json`
- Success message shown

---

### 1b. Tool ad-hoc save path — "Yes" (persist)

**Prompt 1 (search tool):**

```
Use context7_search to find the Context7 library ID for "next.js".
```

When the bordered prompt appears:

- Enter a test key (e.g. `ABC_SEARCH_YES`)
- Choose **Yes** ("Save this value permanently in auth.json?")

**Prompt 2 (get_docs tool) — repeat after cleaning the key again:**

```
Use context7_get_docs with libraryId "/vercel/next.js" and query "app router server components example".
```

- Enter a different test key (e.g. `ABC_GETDOCS_YES`)
- Choose **Yes**

**Expected log lines**:

- `search save pre: ...`
- `search save post: errs=0 ...`
- `get_docs save pre: ...`
- `get_docs save post: errs=0 ...`

**Verify**:

- The key from the "Yes" choice is in `auth.json`
- Subsequent calls to the same tool in the **same session** do not re-prompt

---

### 1c. Tool ad-hoc "No" (runtime-only for this session)

**Goal**: "No" must store the key **only in memory** for the current Pi session using the official runtime override mechanism. It must **not** ask again on later tool calls in the same session. After fully exiting and restarting `pi -e`, it must ask again.

**Sequence**:

1. Clean the key from auth.json.
2. Fresh `pi -e` session.
3. Use this prompt:

   ```
   Use context7_search to find the Context7 library ID for "supabase".
   ```

4. Enter a test key (e.g. `ABC_SEARCH_NO`).
5. Choose **No**.

6. Immediately follow up in the same session with:

   ```
   Now do another context7_search, this time for "react".
   ```

   → **Must not prompt again** for the key.

7. Clean the key, restart Pi completely, and repeat the flow choosing **No** again. Then restart once more and choose **Yes** — it must now persist.

**Expected log lines**:

- `search chose runtime-only (no persist) for this session`
- Same for `get_docs`
- No re-prompt on follow-up calls in the same session
- After full Pi restart: prompt appears again

---

## Step 2: set() Visibility / Sync Behavior

**Goal**: Confirm that after a successful `set()` (or `setRuntimeApiKey`), the very next `getApiKey()` / `has()` in the same process sees the value without requiring a `reload()`.

Covered implicitly by the post-set checks in Step 1. Add explicit follow-up if needed:

After a "Yes" save from a tool, immediately (in the same turn or next message) ask the model to call the tool again. It must succeed without re-prompting.

---

## Step 3: reload() Behavior

**Goal**: Does calling `authStorage.reload()` change anything for our usage?

**Test**:

- Perform a tool "Yes" save.
- In a follow-up message, ask the model to do something that triggers the tool again.
- (We can temporarily add a diagnostic `authStorage.reload()` call if the plan requires explicit testing.)

Record whether the key remains visible after reload.

---

## Step 4: Single Shared Instance Confirmation (Static Analysis + Runtime)

Already verified via grep that only one top-level `AuthStorage.create()` exists.

Runtime confirmation: the pre/post diagnostics in Step 1 already compare the module-level instance against fresh `AuthStorage.create()` calls. They should always agree.

---

## Step 5: No Accidental Runtime-Only Writes When Persisting

Verify in the code (and via logs) that:

- "Yes" path always calls `authStorage.set(...)` + `removeRuntimeApiKey`
- "No" path only calls `setRuntimeApiKey`
- Onboard always calls `set(...)` + `removeRuntimeApiKey`

The diagnostic log lines make this visible.

---

## Step 6: Decline / Cancel Paths

**Test cases**:

- User enters key then presses Esc / cancels the input popup → tool should fail gracefully, no key stored anywhere.
- User reaches the "Save permanently?" popup and cancels → key should only be used for this call (or not at all). Subsequent calls must re-prompt.

**Prompt example for cancel test**:

```
Use context7_search for "astro". When the key prompt appears, cancel it.
```

Then immediately:

```
Try the search for "astro" again.
```

→ Should prompt again.

---

## Additional Useful Prompts

**Force get_docs with a known good ID (after you have a key):**

```
Use context7_get_docs with libraryId "/vercel/next.js" and query "how do I create a server action".
```

**Onboard after runtime key is active:**

```
/context7_onboard
```

(Should offer to overwrite, then persist and clear any runtime override.)

---

## Success Criteria

- Both "Yes" from onboard **and** "Yes" from tool prompts reliably write to `auth.json` using only `AuthStorage.set()`.
- "No" from tools stores via `setRuntimeApiKey()` and does not re-prompt within the session.
- Full Pi restart correctly forgets runtime-only keys.
- No manual `fs` writes to auth.json anywhere.
- All diagnostics pass and `npm run check` is green.

---

**Current status**: Step 1 (especially 1b and 1c) is the active focus. Once we have clean logs from the tool "Yes" and "No" paths across restarts, we can mark Step 1 complete and move to the remaining steps.

When you finish a test run, say "Done" and share (or let me read) `~/.pi/context7-debug.log`.
