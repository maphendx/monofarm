# Daily production and notifications

## Operator flow

1. Link one or more products, quantities per run and a finished-goods warehouse to the file. Use the file library badge or the inline editor before sending. Products are selected explicitly, never inferred from filenames.
2. Choose one sliced plate. The selected plate controls physical dispatch, its filament metadata and the output-plan snapshot. Non-Bambu printers require exported G-code rather than a Bambu 3MF archive. PlateCycler requires its supported default plate or a separately exported file.
3. After taking parts off the bed, open the result action, correct good/defective quantities if needed, review the receipt summary, and confirm. File plans prefill the form.
4. If quantities are not known yet, choose **Звільнити без обліку / Clear without accounting**. Later, use History → **Потребує обліку / Needs accounting**. Late accounting does not change printer state.

Every configured dispatch freezes file outputs on its job. Subsequent file edits do not rewrite that plan. Legacy runs without a snapshot require manual product/warehouse selection.

## Accounting ownership

- Direct and standalone-task prints receipt each physical run separately through the existing movement ledger.
- Reports and stock receipts share a transaction; request replay, history locks and the per-run/product unique movement index prevent duplicate receipt.
- Task completion preserves recorded run quantities and does not repeat receipts or filament deductions. A task previously received in bulk remains accounted through that task; later reports do not duplicate it.
- A snapshotted production batch owns receipt at batch closure. Run reports update its actual quantities only. A closed/missing snapshotted batch is a conflict requiring reconciliation; a newly created batch is never silently substituted.
- Good quantities without a receipt destination remain pending. All-defective runs have no stock receipt and do not block receipt from a later successful run of the same task.
- Final reports are not an inventory-edit interface. Existing warehouse adjustments handle corrections to received stock. `previous_report` preserves the audit when completing a pending report, not arbitrary editing of final receipts.

## Ready-made Telegram rules

Settings → Notifications has separate switches for print failure and low filament. Delivery uses the existing organization's Telegram bot and linked active users. The page distinguishes a missing bot from a bot with no linked users.

`telegram_notify.py` adds a durable delivery queue to the existing service, not a workflow action or a separate notification provider. Queue entries commit or roll back with their source operation. The regular scheduler processes committed entries every five seconds independently of the workflow run worker.

Failure alerts use a stable print-history key, including costing without material telemetry, dispatch history and tracker restart recovery. Nonterminal Bambu warnings remain separate; duplicate legacy terminal sends have been removed.

Filament threshold state lives on the spool. Quantity updates lock spools; costing takes locks in ID order. Continued low readings do not alert again. A refill above the threshold re-arms the rule even while disabled. Changing the threshold to classify stock as low without a downward quantity crossing does not generate a retroactive alert.

### Delivery guarantee and audit

The queue has a unique `(organization_id, event_key)` constraint. Workers claim with `FOR UPDATE SKIP LOCKED`, commit `attempted`, then use the existing Telegram sender. Another worker cannot resend the claimed message.

Telegram delivery is **one automatic attempt**, not guaranteed delivery. A timeout may mean Telegram accepted the message but its response was lost. Failed, partial or interrupted attempts are not automatically retried; this prevents restart/retry spam. Queue status, attempt time and delivered-recipient count stay in the database. There is currently no operator delivery-history/retry UI. Source stock/print operations never wait for the Telegram network.

For each supported event, choose the ready-made rule or a Telegram workflow. The API refuses enabling an overlapping owner with 409, and settings display the actual workflow names. Conditional branches/custom recipients are conservatively treated as possible overlap. Custom HTTP integrations cannot be identified as Telegram notification equivalents.

Migration 0093 conservatively turns off ready-made rules for organizations whose existing enabled workflows contain both the matching event trigger and a Telegram action. It preserves those workflows and their execution history. Review Notifications after upgrade before changing ownership.

## Experimental editor

New organizations start with editor access off. A tenant admin enables it in Settings → Notifications → Experimental features. Existing workflow organizations retain access through migration 0092.

Hiding the editor does not stop active events, cron, webhooks or runs. Organizations with saved workflows retain sidebar access to read-only graphs and run history, a separate disable action, and an admin settings link. Creation, graph edits, deletion and manual run require editor opt-in. Normal print/output/stock operations do not depend on it.

## Migration and verification

Migration 0093 extends 0092; do not rewrite applied migrations. Upgrade the database before restarting application/worker code that reads the new spool fields or queue.

Regression coverage includes file outputs, plate dispatch, multi-run and all-defective task accounting, batch/task receipt ownership, deferred/replayed/concurrent output, org/role isolation, and workflow-disabled core behavior. Notification tests additionally cover transactional rollback, SQL failures in workflow publication, duplicate producers, independent worker claims, restart ambiguity, re-arming while disabled and conflicting notification ownership.

Backend tests use an isolated PostgreSQL database. A root fixture blocks external socket connections as a final guard; printer, Telegram and API boundaries are mocked. Browser acceptance uses a separate frontend process with intercepted API/WebSocket responses, including mobile 390px layouts, save failure, disabled-editor management and both locales. No browser acceptance data is written to the development database.
