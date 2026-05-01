# Test fixtures

`tiny.pcap` is the first 50 packets of `.reference/wireshark-captures/wf-3620/flatbed-single-page-pdf.pcap` (the smallest WF-3620 capture, ~27 MB). Sliced via `tshark -F pcap -w … -c 50` so the file is small enough to commit while still containing real LOCK + a few command exchanges.

To regenerate, recreate from the same source pcap with the same `-c 50` argument.
