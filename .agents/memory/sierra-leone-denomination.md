---
name: Sierra Leone denomination
description: Payza's SLL request code does not establish whether numeric amounts use historic SLL or redenominated SLE units.
---

Preserve SLL currency codes and numeric payment/link/wallet amounts literally. Do not silently relabel them as SLE, multiply or divide by 1,000, or enable SLL reference-rate conversion without authoritative confirmation of the provider's numeric units.

**Why:** Payza documentation requires SLL in requests and suggests SLE for display, but does not specify the amount scale. Historic and redenominated Leone reference rates differ by three orders of magnitude; interpreting the display advice as a conversion contract risks real money.

**How to apply:** Keep SLL FX disabled until provider documentation or written confirmation establishes the denomination. Then review quoting, payouts, refunds, and historical data together; never infer a data migration from the ISO code alone.