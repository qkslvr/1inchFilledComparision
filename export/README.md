# Shadow Resolver export

Shadow measurement of live 1inch Fusion auctions (Base + Ethereum, July 2026, ~50h) comparing three hedge venues per auction: KalqiX order book, KyberSwap aggregator, Bebop RFQ depth. Nothing was executed.

Files: shadow-export.sqlite (tables: glossary, orders, ticks) plus the same orders/ticks as CSV.
Read the glossary table first: it defines every verdict, the edge formula, per-venue methodology, and the honest caveats.

Contents: 521 tracked auctions, 68840 per-second pricing ticks. Untracked flow (dust and unsupported stablecoin rotation without pricing data) is excluded.