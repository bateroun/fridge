import express from "express";
import cors from "cors";
import OpenAI from "openai";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import Database from "better-sqlite3";

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

/* =========================
   환경변수
========================= */
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const JWT_SECRET = process.env.JWT_SECRET;
const DB_PATH = process.env.DB_PATH || "./fridge.db";

if (!OPENAI_API_KEY) {
  console.error("OPENAI_API_KEY is missing");
}
if (!JWT_SECRET) {
  console.error("JWT_SECRET is missing");
}

/* =========================
   DB 초기화
========================= */
const db = new Database(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

/* =========================
   OpenAI 클라이언트
========================= */
const client = new OpenAI({
  apiKey: OPENAI_API_KEY
});

/* =========================
   유틸
========================= */
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

function createToken(user) {
  return jwt.sign(
    {
      id: user.id,
      email: user.email,
      name: user.name
    },
    JWT_SECRET,
    { expiresIn: "7d" }
  );
}

function requireAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization || "";
    const [type, token] = authHeader.split(" ");

    if (type !== "Bearer" || !token) {
      return res.status(401).json({
        error: "로그인이 필요해요."
      });
    }

    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (error) {
    return res.status(401).json({
      error: "유효하지 않은 토큰이에요."
    });
  }
}

/* =========================
   기본 라우트
========================= */
app.get("/", (req, res) => {
  res.send("Fridge AI server is running.");
});

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

/* =========================
   회원가입
========================= */
app.post("/signup", async (req, res) => {
  try {
    const name = String(req.body.name || "").trim();
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");

    if (!name || !email || !password) {
      return res.status(400).json({
        error: "이름, 이메일, 비밀번호를 모두 입력해주세요."
      });
    }

    if (password.length < 6) {
      return res.status(400).json({
        error: "비밀번호는 6자 이상이어야 해요."
      });
    }

    const existingUser = db
      .prepare("SELECT id FROM users WHERE email = ?")
      .get(email);

    if (existingUser) {
      return res.status(409).json({
        error: "이미 가입된 이메일이에요."
      });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const result = db
      .prepare(
        "INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)"
      )
      .run(name, email, passwordHash);

    const newUser = db
      .prepare("SELECT id, name, email, created_at FROM users WHERE id = ?")
      .get(result.lastInsertRowid);

    const token = createToken(newUser);

    res.status(201).json({
      message: "회원가입이 완료됐어요.",
      token,
      user: newUser
    });
  } catch (error) {
    console.error("signup error:", error);
    res.status(500).json({
      error: "회원가입 중 오류가 발생했어요."
    });
  }
});

/* =========================
   로그인
========================= */
app.post("/login", async (req, res) => {
  try {
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");

    if (!email || !password) {
      return res.status(400).json({
        error: "이메일과 비밀번호를 입력해주세요."
      });
    }

    const user = db
      .prepare("SELECT * FROM users WHERE email = ?")
      .get(email);

    if (!user) {
      return res.status(401).json({
        error: "이메일 또는 비밀번호가 올바르지 않아요."
      });
    }

    const isMatch = await bcrypt.compare(password, user.password_hash);

    if (!isMatch) {
      return res.status(401).json({
        error: "이메일 또는 비밀번호가 올바르지 않아요."
      });
    }

    const safeUser = {
      id: user.id,
      name: user.name,
      email: user.email,
      created_at: user.created_at
    };

    const token = createToken(safeUser);

    res.json({
      message: "로그인 성공",
      token,
      user: safeUser
    });
  } catch (error) {
    console.error("login error:", error);
    res.status(500).json({
      error: "로그인 중 오류가 발생했어요."
    });
  }
});

/* =========================
   내 정보 확인
========================= */
app.get("/me", requireAuth, (req, res) => {
  try {
    const user = db
      .prepare("SELECT id, name, email, created_at FROM users WHERE id = ?")
      .get(req.user.id);

    if (!user) {
      return res.status(404).json({
        error: "사용자를 찾을 수 없어요."
      });
    }

    res.json({ user });
  } catch (error) {
    console.error("me error:", error);
    res.status(500).json({
      error: "사용자 정보를 불러오지 못했어요."
    });
  }
});

/* =========================
   보호된 AI 채팅
========================= */
app.post("/chat", requireAuth, async (req, res) => {
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

현재 로그인한 사용자 이름: ${req.user.name}

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
    console.error("chat error:", error);
    res.status(500).json({
      reply: "서버 오류가 발생했어요."
    });
  }
});

app.listen(port, "0.0.0.0", () => {
  console.log(`Server running on port ${port}`);
});
