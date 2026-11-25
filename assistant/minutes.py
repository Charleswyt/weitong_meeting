import re
from datetime import datetime, timezone, timedelta

ZONE = timezone(timedelta(hours=8))


def draft(title, rows):
    sections = {"讨论摘要": [], "决定": [], "行动项": [], "待确认": []}
    for r in rows:
        text = r["text"].strip()
        if not text:
            continue
        line = f"- [{datetime.fromtimestamp(r['at'], ZONE):%H:%M:%S} · #{r['id']}] {r['speaker']}　{text}"
        if re.search(
            r"决定|决议|一致同意|确认采用|决定采用|we (?:agreed|decided)|decision", text, re.I
        ):
            target = "决定"
        elif re.search(
            r"负责|截止|提交|跟进|我来|行动项|will (?:send|prepare|deliver)|by (?:Monday|Tuesday|Friday)",
            text,
            re.I,
        ):
            target = "行动项"
        elif re.search(r"[?？]|待确认|待定|尚未|是否|待核实|unresolved|open question", text, re.I):
            target = "待确认"
        else:
            target = "讨论摘要"
        sections[target].append(line)
    parts = ["# " + title, "时间使用北京时间；句子后的来源编号对应会议转录。"]
    for name, lines in sections.items():
        parts.extend(["## " + name, "\n".join(lines) if lines else "暂无对应发言。"])
    return "\n\n".join(parts)
