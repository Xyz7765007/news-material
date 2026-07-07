# connections-sent card: count "requests that went out", not Status=connection_sent

## What broke
The new `/api/sidekick/connections-sent` GET counted only Outreach rows with
`Status = "connection_sent"`. Within the hour, 2 of 16 Veloka Connect sends were
accepted → their Status flipped to `connected`, so the card headline read **14**
when **16** requests had actually gone out.

## Root cause
`Status` is a moving value (queued → connection_sent → connected → replied →
completed). Counting a terminal-ish status undercounts the moment anything
progresses. The card's question is "how many requests HAVE GONE OUT" (Kunal),
which is a historical fact, not a current state.

## Fix
Key the count on the presence of `Connection Sent At` (the timestamp stamped when
the invite fires), for `Campaign = "Veloka Connect"`, any Status:
`AND({Campaign}="Veloka Connect", {Connection Sent At})` + JS filter `ms > 0 && ms > lastMarkedDone`.
Accepted/replied/completed sends stay counted; only never-sent (queued/error) rows drop out.

## Prevention
For any "how many X happened" metric over the Outreach lifecycle, filter on the
**event timestamp field** (Connection Sent At / Last DM Sent At / Replied At), never
on the mutable `Status`. Status is for "what needs doing next", timestamps are for
"what already happened".
