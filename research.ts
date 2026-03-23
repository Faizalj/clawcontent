/**
 * Research module — pluggable news/idea discovery
 * MVP: Uses web search via fetch. Can swap to Perplexity API later.
 */

export interface ResearchResult {
  title: string;
  summary: string;
  source_url: string;
  relevance: string;
}

/**
 * Search for AI news relevant to a channel's focus
 */
export async function searchNews(
  query: string,
  channelContext: string
): Promise<ResearchResult[]> {
  // MVP: Return structured prompt for OpenClaw agent to research
  // The agent will use its own tools to find news
  return [];
}

/**
 * Build research prompt for OpenClaw agent based on channel config
 */
export function buildResearchPrompt(channel: {
  name: string;
  description: string;
  research_type: string;
}): string {
  const today = new Date().toISOString().split("T")[0];

  if (channel.research_type === "news") {
    return `วันนี้ ${today} — ค้นหาข่าว AI ล่าสุด 5 ข่าวที่เกี่ยวกับ:
${channel.description}

ต้องการ:
1. ข่าวจาก 24-48 ชั่วโมงล่าสุด
2. เน้นข่าวที่เจ้าของธุรกิจไทยสนใจ
3. ข่าวที่สามารถทำเป็น content video ได้

ตอบเป็น JSON array:
[
  {
    "title": "หัวข้อข่าวเป็นภาษาไทย",
    "summary": "สรุป 2-3 ประโยค ว่าข่าวนี้คืออะไร เกี่ยวกับอะไร",
    "source_url": "URL ต้นทาง",
    "relevance": "ทำไมข่าวนี้เกี่ยวกับช่อง ${channel.name}"
  }
]

ตอบ JSON เท่านั้น ไม่ต้อง markdown`;
  }

  if (channel.research_type === "idea") {
    return `วันนี้ ${today} — เสนอ 5 ไอเดีย content video สำหรับช่อง:
${channel.description}

ต้องการ:
1. หัวข้อที่คนสนใจ กำลังเป็น trend
2. สามารถทำเป็น video 3-5 นาทีได้
3. มีมุมมองที่แตกต่าง ไม่ซ้ำกับคนอื่น

ตอบเป็น JSON array:
[
  {
    "title": "หัวข้อเป็นภาษาไทย",
    "summary": "แนวคิดหลัก 2-3 ประโยค",
    "source_url": "",
    "relevance": "ทำไมหัวข้อนี้น่าสนใจ"
  }
]

ตอบ JSON เท่านั้น ไม่ต้อง markdown`;
  }

  // Default: trend
  return `วันนี้ ${today} — ค้นหา 5 เทรนด์ AI ที่กำลังมาแรง เกี่ยวกับ:
${channel.description}

ตอบเป็น JSON array:
[
  {
    "title": "หัวข้อเป็นภาษาไทย",
    "summary": "สรุป 2-3 ประโยค",
    "source_url": "URL ถ้ามี",
    "relevance": "ทำไมเทรนด์นี้สำคัญ"
  }
]

ตอบ JSON เท่านั้น ไม่ต้อง markdown`;
}

/**
 * Build script generation prompt based on approved content
 */
export function buildScriptPrompt(
  channel: { name: string; description: string },
  content: { title: string; summary: string; source_url: string },
  options?: { video_duration?: string; script_format?: string; script_instruction?: string }
): string {
  const duration = options?.video_duration || "3-4min";
  const format = options?.script_format || "4-section";
  const sections = format === "2-section" ? 2 : 4;
  const instruction = options?.script_instruction || "";

  return `เขียน script video สำหรับช่อง "${channel.name}"

หัวข้อ: ${content.title}
แหล่งข่าว: ${content.source_url}
สรุป: ${content.summary}

Format ช่อง: ${channel.description}

โครงสร้าง script (${sections} sections):
${sections >= 4 ? `## [0:00 - 0:25] HOOK
## [0:25 - 1:15] อธิบาย
## [1:15 - 2:30] เกี่ยวกับคุณยังไง
## [2:30 - 3:30] สรุป + CTA` : `## [0:00 - 0:30] HOOK + เนื้อหา
## [0:30 - 1:00] สรุป + CTA`}

${instruction ? `คำแนะนำเพิ่มเติม: ${instruction}\n` : ''}กฎสำคัญ:
1. เขียนเป็นภาษาไทย พูดง่าย ไม่ technical มาก ความยาวรวม ~${duration}
2. ใส่ <!-- image: ... --> ทุกๆ 2-3 ประโยค (ประมาณ 10-15 จุดทั้ง script)
   แต่ละ image prompt เป็นภาษาอังกฤษ อธิบายภาพที่เหมาะกับเนื้อหาตรงนั้น
   เช่น <!-- image: A businessman looking at AI dashboard on laptop, modern office, warm lighting, 16:9 -->
3. image prompt ต้องละเอียด: สี แสง อารมณ์ องค์ประกอบ style
4. ห้ามใส่ metadata เช่น "ความยาว:", "โทน:", "หมายเหตุ:" — เขียนแค่บทพูดเท่านั้น
5. เขียนแค่บทพูดกับ image prompts ไม่ต้องมีคำอธิบายอื่น`;
}
