const GEMINI_MODEL = "gemini-3.6-flash";

const GEMINI_API_URL =
  `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Content-Type": "application/json"
};

const SYSTEM_INSTRUCTION = `
You are Milky Way AI, a helpful, accurate, friendly multilingual AI assistant.

Rules:
- Answer clearly and naturally.
- Be helpful and accurate.
- Keep answers concise when possible.
- Give detailed explanations when requested.
- Respond in the same language and script as the user's latest message whenever appropriate.
- Understand Urdu, Hindi, Roman Urdu, Roman Hindi, Arabic, Persian, Bengali, Punjabi, Chinese, Japanese, Korean, Russian and other languages supported by the model.
- Preserve Unicode, accents, diacritics and the user's writing style.
- Do not transliterate a language unless the user asks you to.
- If the user's wording is unclear, ask for clarification instead of inventing a meaning.
- Never pretend to have abilities you do not have.
- If you are unsure, say so.
- Use clear formatting when useful.
`;

export default {
  async fetch(request, env) {
    // CORS
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders
      });
    }

    const url = new URL(request.url);

    try {
      // AI CHAT
      if (
        (url.pathname === "/" || url.pathname === "/chat") &&
        request.method === "POST"
      ) {
        return await chat(request, env);
      }

      // SIGN UP
      if (
        url.pathname === "/auth/signup" &&
        request.method === "POST"
      ) {
        return await signup(request, env);
      }

      // LOGIN
      if (
        url.pathname === "/auth/login" &&
        request.method === "POST"
      ) {
        return await login(request, env);
      }

      // CURRENT USER
      if (
        url.pathname === "/auth/me" &&
        request.method === "GET"
      ) {
        return await getCurrentUser(request, env);
      }

      // GET CHATS
      if (
        url.pathname === "/chats" &&
        request.method === "GET"
      ) {
        return await getChats(request, env);
      }

      // SAVE CHATS
      if (
        url.pathname === "/chats" &&
        request.method === "PUT"
      ) {
        return await saveChats(request, env);
      }

      return jsonResponse(
        { error: "Not found." },
        404
      );

    } catch (error) {
      console.error("Worker Error:", error);

      if (error instanceof Response) {
        return new Response(error.body, {
          status: error.status,
          headers: corsHeaders
        });
      }

      return jsonResponse(
        {
          error: error.message || "Internal server error."
        },
        500
      );
    }
  }
};


// =========================================================
// GEMINI CHAT
// =========================================================

async function chat(request, env) {

  if (!env.GEMINI_API_KEY) {
    return jsonResponse(
      {
        error: "GEMINI_API_KEY is not configured."
      },
      500
    );
  }

  const body = await request.json();

  const messages = body.messages;

  if (
    !Array.isArray(messages) ||
    messages.length === 0
  ) {
    return jsonResponse(
      {
        error: "No messages provided."
      },
      400
    );
  }

  const contents = messages
    .filter(
      message =>
        message &&
        typeof message.content === "string" &&
        (
          message.role === "user" ||
          message.role === "assistant"
        )
    )
    .map(message => ({
      role:
        message.role === "assistant"
          ? "model"
          : "user",

      parts: [
        {
          text: message.content
        }
      ]
    }));

  if (contents.length === 0) {
    return jsonResponse(
      {
        error: "No valid messages found."
      },
      400
    );
  }

  const geminiResponse = await fetch(
    GEMINI_API_URL,
    {
      method: "POST",

      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": env.GEMINI_API_KEY
      },

      body: JSON.stringify({
        system_instruction: {
          parts: [
            {
              text: SYSTEM_INSTRUCTION
            }
          ]
        },

        contents,

        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: 2048
        }
      })
    }
  );

  const geminiData =
    await geminiResponse.json();

  if (!geminiResponse.ok) {

    console.error(
      "Gemini API Error:",
      geminiData
    );

    return jsonResponse(
      {
        error:
          geminiData?.error?.message ||
          "Gemini API request failed."
      },
      geminiResponse.status
    );
  }

  let reply = "";

  const candidate =
    geminiData?.candidates?.[0];

  if (
    candidate?.content?.parts &&
    Array.isArray(candidate.content.parts)
  ) {
    reply =
      candidate.content.parts
        .filter(
          part =>
            typeof part.text === "string"
        )
        .map(part => part.text)
        .join("");
  }

  if (!reply.trim()) {

    console.error(
      "Unexpected Gemini response:",
      geminiData
    );

    return jsonResponse(
      {
        error:
          "Gemini did not return any text."
      },
      502
    );
  }

  return jsonResponse({
    reply: reply.trim()
  });
}


// =========================================================
// AUTHENTICATION
// =========================================================

async function signup(request, env) {

  if (!env.DB) {
    return jsonResponse(
      {
        error:
          "D1 database is not configured."
      },
      500
    );
  }

  const body = await request.json();

  const email =
    String(body.email || "")
      .trim()
      .toLowerCase();

  const password =
    String(body.password || "");

  validateCredentials(
    email,
    password
  );

  const existing =
    await env.DB
      .prepare(
        "SELECT id FROM users WHERE email = ?"
      )
      .bind(email)
      .first();

  if (existing) {
    return jsonResponse(
      {
        error:
          "An account with that email already exists."
      },
      409
    );
  }

  const userId =
    crypto.randomUUID();

  const passwordHash =
    await hashPassword(password);

  await env.DB
    .prepare(`
      INSERT INTO users
      (
        id,
        email,
        password_hash,
        created_at
      )
      VALUES (?, ?, ?, ?)
    `)
    .bind(
      userId,
      email,
      passwordHash,
      Date.now()
    )
    .run();

  const token =
    await createSession(
      env.DB,
      userId
    );

  return jsonResponse({
    token,
    email
  });
}


async function login(request, env) {

  if (!env.DB) {
    return jsonResponse(
      {
        error:
          "D1 database is not configured."
      },
      500
    );
  }

  const body = await request.json();

  const email =
    String(body.email || "")
      .trim()
      .toLowerCase();

  const password =
    String(body.password || "");

  validateCredentials(
    email,
    password
  );

  const user =
    await env.DB
      .prepare(`
        SELECT
          id,
          email,
          password_hash
        FROM users
        WHERE email = ?
      `)
      .bind(email)
      .first();

  if (!user) {
    return jsonResponse(
      {
        error:
          "Invalid email or password."
      },
      401
    );
  }

  const valid =
    await verifyPassword(
      password,
      user.password_hash
    );

  if (!valid) {
    return jsonResponse(
      {
        error:
          "Invalid email or password."
      },
      401
    );
  }

  const token =
    await createSession(
      env.DB,
      user.id
    );

  return jsonResponse({
    token,
    email: user.email
  });
}


async function getCurrentUser(
  request,
  env
) {

  if (!env.DB) {
    return jsonResponse(
      {
        error:
          "D1 database is not configured."
      },
      500
    );
  }

  const user =
    await authenticate(
      request,
      env.DB
    );

  return jsonResponse({
    email: user.email
  });
}


// =========================================================
// CHAT STORAGE
// =========================================================

async function getChats(
  request,
  env
) {

  if (!env.DB) {
    return jsonResponse(
      {
        error:
          "D1 database is not configured."
      },
      500
    );
  }

  const user =
    await authenticate(
      request,
      env.DB
    );

  const row =
    await env.DB
      .prepare(`
        SELECT chats_json
        FROM user_chats
        WHERE user_id = ?
      `)
      .bind(user.id)
      .first();

  let chats = [];

  if (row?.chats_json) {
    try {
      chats =
        JSON.parse(
          row.chats_json
        );
    } catch {
      chats = [];
    }
  }

  return jsonResponse({
    chats:
      Array.isArray(chats)
        ? chats
        : []
  });
}


async function saveChats(
  request,
  env
) {

  if (!env.DB) {
    return jsonResponse(
      {
        error:
          "D1 database is not configured."
      },
      500
    );
  }

  const user =
    await authenticate(
      request,
      env.DB
    );

  const body =
    await request.json();

  if (!Array.isArray(body.chats)) {
    return jsonResponse(
      {
        error:
          "chats must be an array."
      },
      400
    );
  }

  // Keep reasonable limits.
  const chats =
    body.chats
      .slice(0, 100)
      .map(chat => ({
        id:
          String(
            chat.id ||
            crypto.randomUUID()
          ),

        title:
          String(
            chat.title ||
            "New chat"
          ).slice(0, 100),

        updatedAt:
          Number(
            chat.updatedAt ||
            Date.now()
          ),

        messages:
          Array.isArray(chat.messages)
            ? chat.messages
                .slice(-100)
                .map(message => ({
                  role:
                    message.role ===
                    "assistant"
                      ? "assistant"
                      : "user",

                  content:
                    String(
                      message.content ||
                      ""
                    ).slice(0, 50000)
                }))
            : []
      }));

  await env.DB
    .prepare(`
      INSERT INTO user_chats
      (
        user_id,
        chats_json,
        updated_at
      )
      VALUES (?, ?, ?)

      ON CONFLICT(user_id)
      DO UPDATE SET
        chats_json =
          excluded.chats_json,

        updated_at =
          excluded.updated_at
    `)
    .bind(
      user.id,
      JSON.stringify(chats),
      Date.now()
    )
    .run();

  return jsonResponse({
    ok: true
  });
}


// =========================================================
// AUTH HELPERS
// =========================================================

function validateCredentials(
  email,
  password
) {

  const emailPattern =
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  if (!emailPattern.test(email)) {
    throw new Error(
      "Enter a valid email address."
    );
  }

  if (password.length < 8) {
    throw new Error(
      "Password must be at least 8 characters."
    );
  }
}


async function createSession(
  db,
  userId
) {

  const bytes =
    new Uint8Array(32);

  crypto.getRandomValues(bytes);

  const token =
    Array.from(bytes)
      .map(
        byte =>
          byte
            .toString(16)
            .padStart(2, "0")
      )
      .join("");

  const expiresAt =
    Date.now() +
    30 *
    24 *
    60 *
    60 *
    1000;

  await db
    .prepare(`
      INSERT INTO sessions
      (
        token,
        user_id,
        expires_at
      )
      VALUES (?, ?, ?)
    `)
    .bind(
      token,
      userId,
      expiresAt
    )
    .run();

  return token;
}


async function authenticate(
  request,
  db
) {

  const authorization =
    request.headers.get(
      "Authorization"
    ) || "";

  if (
    !authorization.startsWith(
      "Bearer "
    )
  ) {
    throw new Response(
      JSON.stringify({
        error: "Unauthorized."
      }),
      {
        status: 401,
        headers: corsHeaders
      }
    );
  }

  const token =
    authorization.slice(7);

  const user =
    await db
      .prepare(`
        SELECT
          users.id,
          users.email

        FROM sessions

        JOIN users
          ON users.id =
             sessions.user_id

        WHERE sessions.token = ?
          AND sessions.expires_at > ?
      `)
      .bind(
        token,
        Date.now()
      )
      .first();

  if (!user) {
    throw new Response(
      JSON.stringify({
        error:
          "Invalid or expired session."
      }),
      {
        status: 401,
        headers: corsHeaders
      }
    );
  }

  return user;
}


// =========================================================
// PASSWORD HASHING
// =========================================================

async function hashPassword(
  password
) {

  const salt =
    new Uint8Array(16);

  crypto.getRandomValues(salt);

  const key =
    await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(
        password
      ),
      "PBKDF2",
      false,
      ["deriveBits"]
    );

  const bits =
    await crypto.subtle.deriveBits(
      {
        name: "PBKDF2",
        salt,
        iterations: 100000,
        hash: "SHA-256"
      },
      key,
      256
    );

  return (
    "pbkdf2$100000$" +
    bytesToHex(salt) +
    "$" +
    bytesToHex(
      new Uint8Array(bits)
    )
  );
}


async function verifyPassword(
  password,
  stored
) {

  const parts =
    String(stored).split("$");

  if (parts.length !== 4) {
    return false;
  }

  const iterations =
    Number(parts[1]);

  const salt =
    hexToBytes(parts[2]);

  const expected =
    parts[3];

  const key =
    await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(
        password
      ),
      "PBKDF2",
      false,
      ["deriveBits"]
    );

  const bits =
    await crypto.subtle.deriveBits(
      {
        name: "PBKDF2",
        salt,
        iterations,
        hash: "SHA-256"
      },
      key,
      256
    );

  const actual =
    bytesToHex(
      new Uint8Array(bits)
    );

  return timingSafeEqual(
    actual,
    expected
  );
}


// =========================================================
// UTILITIES
// =========================================================

function bytesToHex(bytes) {

  return Array.from(bytes)
    .map(
      byte =>
        byte
          .toString(16)
          .padStart(2, "0")
    )
    .join("");
}


function hexToBytes(hex) {

  const bytes =
    new Uint8Array(
      hex.length / 2
    );

  for (
    let i = 0;
    i < bytes.length;
    i++
  ) {
    bytes[i] =
      parseInt(
        hex.slice(
          i * 2,
          i * 2 + 2
        ),
        16
      );
  }

  return bytes;
}


function timingSafeEqual(
  a,
  b
) {

  if (a.length !== b.length) {
    return false;
  }

  let result = 0;

  for (
    let i = 0;
    i < a.length;
    i++
  ) {
    result |=
      a.charCodeAt(i) ^
      b.charCodeAt(i);
  }

  return result === 0;
}


function jsonResponse(
  data,
  status = 200
) {

  return new Response(
    JSON.stringify(data),
    {
      status,
      headers: corsHeaders
    }
  );
}