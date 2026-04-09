import express from "express";
import cors from "cors";
import OpenAI from "openai";

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

function sectionLabel(key) {
  if (key === "fridge") return "냉장";
  if (key === "frozen") return "냉동";
  if (key === "room") return "실온";
  return key;
}

function normalizeFridge(fridge) {
  if (!fridge || typeof fridge !== "object") return [];

  const result = [];

  for (const [sectionKey, sectionValue] of Object.entries(fridge)) {
    const sectionName = sectionLabel(sectionKey);
    const zones = Array.isArray(sectionValue?.zones) ? sectionValue.zones : [];

    for (const zone of zones) {
      const zoneName = zone?.name ?? "이름 없음";
      const items = Array.isArray(zone?.items) ? zone.items : [];

      for (const item of items) {
        result.push({
          section: sectionName,
          zone: zoneName,
          name: item?.name ?? "이름 없음",
          amount: item?.amount ?? "1개",
          dday: item?.dday ?? "?",
          status: item?.status ?? "unknown"
        });
      }
    }
  }

  return result;
}

function makeFridgeText(flatItems) {
  if (!flatItems.length) return "현재 등록된 식재료 없음";

  const grouped = {};
  for (const item of flatItems) {
    const key = `${item.section} > ${item.zone}`;
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(item);
  }

  return Object.entries(grouped)
    .map(([groupName, items]) => {
      const lines = items.map((item) =>
        `- ${item.name} | 수량: ${item.amount} | D-${item.dday} | 상태: ${item.status}`
      );
      return `${groupName}\n${lines.join("\n")}`;
    })
    .join("\n\n");
}

app.get("/", (req, res) => {
  res.send("Fridge AI server is running.");
});

app.post("/chat", async (req, res) => {
  try {
    const userMessage = req.body.message ?? "";
    const fridgeState = req.body.fridgeState ?? {};
    const flatItems = normalizeFridge(fridgeState);
    const fridgeText = makeFridgeText(flatItems);

    const response = await client.responses.create({
      model: "gpt-5-mini",
      input: [
        {
          role: "system",
          content: `
너는 냉장고 관리 앱의 AI 어시스턴트다.

아래는 사용자의 현재 냉장고 상태다:
${fridgeText}

규칙:
- 반드시 위 식재료만 기준으로 답해라.
- 없는 재료를 사용한다고 단정하지 마라.
- 유통기한이 임박한 재료를 우선 고려해라.
- 답변은 한국어로, 짧고 실용적으로 해라.
- 사용자가 현재 가진 재료를 묻는 경우 구역별로 정리해서 보여줘.
`
        },
        {
          role: "user",
          content: userMessage
        }
      ]
    });

    res.json({
      reply: response.output_text || "응답을 만들지 못했어요."
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      reply: "서버 오류가 발생했어요."
    });
  }
});

app.listen(port, "0.0.0.0", () => {
  console.log(`Server running on port ${port}`);
});