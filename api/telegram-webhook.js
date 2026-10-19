
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHANNEL_ID =
  process.env.TELEGRAM_CHANNEL_ID || "-1004379137599";
const TELEGRAM_WEBHOOK_SECRET =
  process.env.TELEGRAM_WEBHOOK_SECRET || "";

const SUPABASE_URL =
  process.env.SUPABASE_URL ||
  "https://mgcpqbqmrzegyufukckv.supabase.co";
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;

const META_PIXEL_ID =
  process.env.META_PIXEL_ID || "1376853070922113";
const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;
const META_GRAPH_VERSION =
  process.env.META_GRAPH_VERSION || "v24.0";
const META_EVENT_NAME =
  process.env.META_EVENT_NAME || "Subscribe";

const APP_URL =
  process.env.APP_URL ||
  "https://freelancing-work-ten.vercel.app";

function json(res, status, body) {
  res.status(status);
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

async function supabaseRequest(path, options = {}) {
  const response = await fetch(
    `${SUPABASE_URL}/rest/v1/${path}`,
    {
      method: options.method || "GET",
      headers: {
        apikey: SUPABASE_SECRET_KEY,
        Authorization: `Bearer ${SUPABASE_SECRET_KEY}`,
        "Content-Type": "application/json",
        ...(options.headers || {})
      },
      body:
        options.body !== undefined
          ? JSON.stringify(options.body)
          : undefined
    }
  );

  const text = await response.text();
  let data;

  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  if (!response.ok) {
    throw new Error(`Supabase ${response.status}: ${text}`);
  }

  return data;
}

async function telegramRequest(method, payload = {}) {
  if (!TELEGRAM_BOT_TOKEN) {
    throw new Error("TELEGRAM_BOT_TOKEN is missing");
  }

  const response = await fetch(
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    }
  );

  const data = await response.json();

  if (!response.ok || !data.ok) {
    throw new Error(
      `Telegram ${method} failed: ${JSON.stringify(data)}`
    );
  }

  return data;
}

function isTelegramMember(status) {
  return (
    status === "member" ||
    status === "administrator" ||
    status === "creator"
  );
}

async function approveJoinRequest(request) {
  const chatId = String(request?.chat?.id ?? "");
  const userId = request?.from?.id;

  if (!chatId) {
    throw new Error("Telegram chat ID missing");
  }

  if (!userId) {
    throw new Error("Telegram user ID missing");
  }

  let memberInfo;

  try {
    memberInfo = await telegramRequest("getChatMember", {
      chat_id: chatId,
      user_id: userId
    });
  } catch (error) {
    console.log(
      `Could not check membership: ${error.message}`
    );
  }

  const currentStatus = memberInfo?.result?.status;

  if (isTelegramMember(currentStatus)) {
    return {
      ok: true,
      already_member: true,
      status: currentStatus
    };
  }

  try {
    return await telegramRequest("approveChatJoinRequest", {
      chat_id: chatId,
      user_id: userId
    });
  } catch (error) {
    if (
      String(error?.message || "")
        .includes("USER_ALREADY_PARTICIPANT")
    ) {
      return {
        ok: true,
        already_member: true
      };
    }

    throw error;
  }
}

async function findTrackedInvite(inviteLink) {
  if (!inviteLink) return null;

  const rows = await supabaseRequest(
    `telegram_invites?invite_link=eq.${encodeURIComponent(
      inviteLink
    )}&is_revoked=eq.false&select=*`
  );

  return Array.isArray(rows) && rows.length
    ? rows[0]
    : null;
}

async function findExistingJoin(telegramUserId, channelId) {
  const user = encodeURIComponent(String(telegramUserId));
  const channel = encodeURIComponent(String(channelId));

  const rows = await supabaseRequest(
    `telegram_joins?telegram_user_id=eq.${user}&telegram_channel_id=eq.${channel}&select=*&order=created_at.desc&limit=1`
  );

  return Array.isArray(rows) && rows.length
    ? rows[0]
    : null;
}

async function saveJoinRequest(request) {
  const inviteLink =
    request?.invite_link?.invite_link || null;

  if (!inviteLink) {
    console.log("Join request has no invite link");
    return {
      tracked: false,
      join: null,
      invite: null
    };
  }

  const invite = await findTrackedInvite(inviteLink);

  if (!invite) {
    console.log(`Untracked Telegram invite: ${inviteLink}`);
    return {
      tracked: false,
      join: null,
      invite: null
    };
  }

  const telegramUser = request?.from;

  if (!telegramUser?.id) {
    throw new Error("Telegram join request has no user");
  }

  const channelId = String(
    request?.chat?.id || TELEGRAM_CHANNEL_ID
  );

  const existing = await findExistingJoin(
    telegramUser.id,
    channelId
  );

  if (existing) {
    return {
      tracked: true,
      join: existing,
      invite
    };
  }

  const inserted = await supabaseRequest("telegram_joins", {
    method: "POST",
    headers: {
      Prefer: "return=representation"
    },
    body: {
      tracking_id: invite.tracking_id,
      invite_link: inviteLink,
      telegram_channel_id: channelId,
      telegram_user_id: String(telegramUser.id),
      telegram_username: telegramUser.username || null,
      telegram_first_name: telegramUser.first_name || null,
      telegram_last_name: telegramUser.last_name || null,
      meta_event_sent: false
    }
  });

  const join = Array.isArray(inserted)
    ? inserted[0]
    : inserted;

  console.log(
    `Join request tracked ${invite.tracking_id}`
  );

  return {
    tracked: true,
    join,
    invite
  };
}

async function findPendingJoin(telegramUserId, channelId) {
  const user = encodeURIComponent(String(telegramUserId));
  const channel = encodeURIComponent(String(channelId));

  const rows = await supabaseRequest(
    `telegram_joins?telegram_user_id=eq.${user}&telegram_channel_id=eq.${channel}&meta_event_sent=eq.false&select=*&order=created_at.desc&limit=1`
  );

  return Array.isArray(rows) && rows.length
    ? rows[0]
    : null;
}

function isMemberStatus(status) {
  return (
    status === "member" ||
    status === "administrator" ||
    status === "creator"
  );
}

function isNewJoin(chatMember) {
  const oldStatus =
    chatMember?.old_chat_member?.status;

  const newStatus =
    chatMember?.new_chat_member?.status;

  return (
    !isMemberStatus(oldStatus) &&
    isMemberStatus(newStatus)
  );
}

async function getLandingVisit(trackingId) {
  if (!trackingId) return null;

  const rows = await supabaseRequest(
    `landing_visits?tracking_id=eq.${encodeURIComponent(
      trackingId
    )}&select=*&limit=1`
  );

  return Array.isArray(rows) && rows.length
    ? rows[0]
    : null;
}

async function sendMetaEvent({
  trackingId,
  landingVisit,
  eventId
}) {
  if (!META_PIXEL_ID) {
    throw new Error("META_PIXEL_ID is missing");
  }

  if (!META_ACCESS_TOKEN) {
    throw new Error("META_ACCESS_TOKEN is missing");
  }

  const event = {
    event_name: META_EVENT_NAME,
    event_time: Math.floor(Date.now() / 1000),
    event_id: eventId,
    action_source: "website",
    event_source_url:
      landingVisit?.landing_page || APP_URL,
    user_data: {},
    custom_data: {
      source: "telegram"
    }
  };

  if (landingVisit?.fbc) {
    event.user_data.fbc = landingVisit.fbc;
  }

  if (landingVisit?.fbp) {
    event.user_data.fbp = landingVisit.fbp;
  }

  if (!event.user_data.fbc && !event.user_data.fbp) {
    console.warn(
      `No fbc/fbp for tracked join ${trackingId || "unknown"}`
    );
  }

  const endpoint =
    `https://graph.facebook.com/${META_GRAPH_VERSION}/${META_PIXEL_ID}/events?access_token=${encodeURIComponent(
      META_ACCESS_TOKEN
    )}`;

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      data: [event]
    })
  });

  const responseText = await response.text();
  let responseData;

  try {
    responseData = responseText
      ? JSON.parse(responseText)
      : null;
  } catch {
    responseData = responseText;
  }

  if (!response.ok) {
    throw new Error(
      `Meta CAPI ${response.status}: ${responseText}`
    );
  }

  if (
    typeof responseData?.events_received === "number" &&
    responseData.events_received < 1
  ) {
    throw new Error(
      `Meta CAPI accepted zero events: ${responseText}`
    );
  }

  if (responseData?.error) {
    throw new Error(
      `Meta CAPI error: ${JSON.stringify(responseData)}`
    );
  }

  console.log(
    `Meta ${META_EVENT_NAME} sent for ${trackingId || "unknown"}`
  );

  return responseData;
}

async function saveMetaEvent({
  trackingId,
  telegramJoinId,
  eventId,
  landingVisit,
  status,
  responseBody
}) {
  return await supabaseRequest(
    "meta_events?on_conflict=event_id",
    {
      method: "POST",
      headers: {
        Prefer: "resolution=merge-duplicates,return=representation"
      },
      body: {
        tracking_id: trackingId || null,
        telegram_join_id: telegramJoinId || null,
        event_name: META_EVENT_NAME,
        event_id: eventId,
        event_time: new Date().toISOString(),
        fbclid: landingVisit?.fbclid || null,
        fbc: landingVisit?.fbc || null,
        fbp: landingVisit?.fbp || null,
        event_source_url:
          landingVisit?.landing_page || APP_URL,
        status: status || "pending",
        response_body: responseBody
          ? JSON.stringify(responseBody)
          : null
      }
    }
  );
}

async function markJoinMetaSent(joinId, eventId) {
  if (!joinId) return;

  await supabaseRequest(
    `telegram_joins?id=eq.${encodeURIComponent(
      String(joinId)
    )}`,
    {
      method: "PATCH",
      headers: {
        Prefer: "return=minimal"
      },
      body: {
        meta_event_sent: true,
        meta_event_id: eventId
      }
    }
  );
}

async function processActualJoin(chatMember) {
  if (!isNewJoin(chatMember)) {
    console.log(
      "chat_member update ignored: not a new join"
    );
    return {
      processed: false,
      reason: "not_new_join"
    };
  }

  const telegramUser =
    chatMember?.new_chat_member?.user;

  if (!telegramUser?.id) {
    throw new Error(
      "chat_member update has no user"
    );
  }

  const channelId = String(
    chatMember?.chat?.id || TELEGRAM_CHANNEL_ID
  );

  const pendingJoin = await findPendingJoin(
    telegramUser.id,
    channelId
  );

  if (!pendingJoin) {
    console.log(
      `No pending tracked join for ${telegramUser.id}`
    );
    return {
      processed: false,
      reason: "no_pending_join"
    };
  }

  if (pendingJoin.meta_event_sent) {
    return {
      processed: false,
      reason: "already_sent"
    };
  }

  const landingVisit = await getLandingVisit(
    pendingJoin.tracking_id
  );

  const eventId =
    pendingJoin.meta_event_id ||
    `telegram_join_${pendingJoin.id}`;

  try {
    const metaResponse = await sendMetaEvent({
      trackingId: pendingJoin.tracking_id,
      landingVisit,
      eventId
    });

    await saveMetaEvent({
      trackingId: pendingJoin.tracking_id,
      telegramJoinId: pendingJoin.id,
      eventId,
      landingVisit,
      status: "sent",
      responseBody: metaResponse
    });

    await markJoinMetaSent(
      pendingJoin.id,
      eventId
    );

    console.log(
      `Actual Telegram join processed: ${pendingJoin.tracking_id}`
    );

    return {
      processed: true,
      tracking_id: pendingJoin.tracking_id,
      event_id: eventId
    };

  } catch (error) {
    console.error(
      `Meta event failed for ${pendingJoin.tracking_id}:`,
      error
    );

    try {
      await saveMetaEvent({
        trackingId: pendingJoin.tracking_id,
        telegramJoinId: pendingJoin.id,
        eventId,
        landingVisit,
        status: "failed",
        responseBody: {
          error: error?.message || String(error)
        }
      });
    } catch (logError) {
      console.error(
        "Failed to save Meta error log:",
        logError
      );
    }

    return {
      processed: false,
      reason: "meta_event_failed",
      tracking_id: pendingJoin.tracking_id,
      event_id: eventId
    };
  }
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return json(res, 405, {
        ok: false,
        error: "Method Not Allowed"
      });
    }

    if (TELEGRAM_WEBHOOK_SECRET) {
      const receivedSecret =
        req.headers["x-telegram-bot-api-secret-token"];

      if (receivedSecret !== TELEGRAM_WEBHOOK_SECRET) {
        console.warn("Invalid Telegram webhook secret");

        return json(res, 401, {
          ok: false,
          error: "Unauthorized"
        });
      }
    }

    const update = req.body || {};

    if (update.chat_join_request) {
      const request = update.chat_join_request;

      console.log(
        `Received Telegram join request from ${
          request?.from?.id || "unknown"
        }`
      );

      const result = await saveJoinRequest(request);
      let approved = false;

      if (result.tracked) {
        try {
          await approveJoinRequest(request);
          approved = true;
        } catch (approvalError) {
          console.error(
            "Telegram auto approval failed:",
            approvalError
          );
        }
      }

      return json(res, 200, {
        ok: true,
        type: "chat_join_request",
        tracked: result.tracked,
        tracking_id:
          result.join?.tracking_id ||
          result.invite?.tracking_id ||
          null,
        approved
      });
    }

    if (update.chat_member) {
      const result = await processActualJoin(
        update.chat_member
      );

      return json(res, 200, {
        ok: true,
        type: "chat_member",
        ...result
      });
    }

    return json(res, 200, {
      ok: true,
      ignored: true
    });

  } catch (error) {
    console.error("Telegram webhook error:", error);

    return json(res, 500, {
      ok: false,
      error: "webhook_failed",
      detail: error?.message || String(error)
    });
  }
    }
