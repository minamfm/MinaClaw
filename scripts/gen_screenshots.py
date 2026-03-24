#!/usr/bin/env python3
"""Generate Telegram and WhatsApp chat mockup screenshots for MinaClaw README."""

from PIL import Image, ImageDraw, ImageFont
import os, textwrap, math

OUT = os.path.join(os.path.dirname(__file__), "../docs/screenshots")
os.makedirs(OUT, exist_ok=True)

# ── Fonts ────────────────────────────────────────────────────────────────────
def load_font(size, bold=False):
    candidates = [
        f"/usr/share/fonts/truetype/dejavu/DejaVu{'Sans-Bold' if bold else 'Sans'}.ttf",
        f"/usr/share/fonts/truetype/liberation/LiberationSans-{'Bold' if bold else 'Regular'}.ttf",
        f"/usr/share/fonts/truetype/freefont/Free{'SerifBold' if bold else 'Serif'}.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    ]
    for p in candidates:
        if os.path.exists(p):
            return ImageFont.truetype(p, size)
    return ImageFont.load_default()


# ── Colour palettes ──────────────────────────────────────────────────────────
TG = dict(
    bg="#17212b", header="#242f3d", input_bar="#1c2733",
    bubble_out="#2b5278", bubble_in="#182533",
    text_out="#ffffff", text_in="#ffffff", text_meta="#6c839b",
    header_text="#ffffff", accent="#5288c1", time="#6c839b",
    status_bar="#0d1117",
)
WA = dict(
    bg="#0b141a", header="#202c33", input_bar="#1f2c34",
    bubble_out="#005c4b", bubble_in="#202c33",
    text_out="#e9edef", text_in="#e9edef", text_meta="#8696a0",
    header_text="#e9edef", accent="#00a884", time="#8696a0",
    status_bar="#090f13",
)

W, H_BASE = 390, 844   # iPhone-ish portrait


def rounded_rect(draw, xy, radius, fill, outline=None, width=1):
    x0, y0, x1, y1 = xy
    draw.rounded_rectangle([x0, y0, x1, y1], radius=radius, fill=fill,
                           outline=outline, width=width)


def draw_checkmarks(draw, x, y, color, double=True):
    """Draw single or double Telegram-style tick marks."""
    size = 7
    for i in range(2 if double else 1):
        ox = i * 5
        pts = [(x+ox, y+4), (x+2+ox, y+6), (x+6+ox, y+1)]
        draw.line([pts[0], pts[1]], fill=color, width=1)
        draw.line([pts[1], pts[2]], fill=color, width=1)


def wrap_text(text, font, max_w, draw):
    """Wrap text to fit within max_w pixels."""
    words = text.split()
    lines, line = [], []
    for w in words:
        test = " ".join(line + [w])
        bbox = draw.textbbox((0, 0), test, font=font)
        if bbox[2] - bbox[0] <= max_w:
            line.append(w)
        else:
            if line:
                lines.append(" ".join(line))
            line = [w]
    if line:
        lines.append(" ".join(line))
    return lines or [""]


def bubble_height(lines, font, pad_v=10):
    line_h = font.size + 4
    return len(lines) * line_h + pad_v * 2


def make_image(pal, messages, title, subtitle, avatar_letter, filename,
               header_color=None):
    """
    messages: list of dicts:
      { role: 'user'|'agent', text: str, time: str,
        ticks: 0|1|2,           # only for user bubbles
        label: str|None,        # small grey label above bubble
        buttons: [str]|None }   # inline buttons (Telegram style)
    """
    font_sm  = load_font(12)
    font_md  = load_font(14)
    font_md_b = load_font(14, bold=True)
    font_lg  = load_font(16)
    font_hdr = load_font(17, bold=True)
    font_sub = load_font(12)

    PAD_H = 12      # horizontal padding inside bubbles
    PAD_V = 8       # vertical padding inside bubbles
    MAX_BUB = 270   # max bubble width
    MARGIN  = 12    # screen margin

    # ── First pass: measure total height needed ──────────────────────────────
    dummy = Image.new("RGB", (W, 1))
    dd = ImageDraw.Draw(dummy)

    total_h = 0
    rendered = []  # store computed layout per message

    for msg in messages:
        entry = {}
        if msg.get("label"):
            total_h += 22
        if msg.get("system_label"):
            total_h += 28

        lines = wrap_text(msg["text"], font_md, MAX_BUB - PAD_H * 2, dd)
        bh = bubble_height(lines, font_md, PAD_V)
        bw = min(MAX_BUB, max(
            max(dd.textbbox((0,0), l, font=font_md)[2] for l in lines)
              + PAD_H * 2 + (40 if msg["role"] == "user" else 0),
            120
        ))

        # extra height for buttons
        btn_extra = 0
        if msg.get("buttons"):
            btn_extra = len(msg["buttons"]) * 36 + 6

        total_h += bh + btn_extra + 10
        rendered.append({"lines": lines, "bh": bh, "bw": bw,
                         "btn_extra": btn_extra})

    total_h += 20  # bottom padding

    H = max(H_BASE, total_h + 56 + 72 + 50)  # status + header + input

    img = Image.new("RGB", (W, H), pal["bg"])
    draw = ImageDraw.Draw(img)

    # ── Status bar ───────────────────────────────────────────────────────────
    draw.rectangle([0, 0, W, 28], fill=pal["status_bar"])
    draw.text((16, 7), "9:41", font=load_font(12, bold=True), fill="#ffffff")
    draw.text((W-50, 7), "●●●", font=load_font(10), fill="#ffffff")

    # ── Header ───────────────────────────────────────────────────────────────
    hdr_col = header_color or pal["header"]
    draw.rectangle([0, 28, W, 82], fill=hdr_col)

    # Avatar circle
    ac = header_color or pal["accent"]
    draw.ellipse([12, 35, 58, 75], fill=ac)
    draw.text((27, 47), avatar_letter, font=load_font(18, bold=True),
              fill="#ffffff")

    draw.text((68, 37), title, font=font_hdr, fill=pal["header_text"])
    draw.text((68, 58), subtitle, font=font_sub, fill=pal["text_meta"])

    # ── Messages ─────────────────────────────────────────────────────────────
    y = 92

    for msg, r in zip(messages, rendered):
        is_user = msg["role"] == "user"
        lines, bh, bw = r["lines"], r["bh"], r["bw"]

        # System / date label
        if msg.get("system_label"):
            lw = dd.textbbox((0,0), msg["system_label"], font=font_sm)[2]
            rounded_rect(draw, [(W-lw)//2 - 8, y, (W+lw)//2 + 8, y+20],
                         radius=10, fill="#1e2d3a")
            draw.text(((W-lw)//2, y+3), msg["system_label"],
                      font=font_sm, fill=pal["text_meta"])
            y += 28

        # Section label
        if msg.get("label"):
            draw.text((MARGIN, y+4), msg["label"],
                      font=font_sm, fill=pal["text_meta"])
            y += 22

        # Bubble position
        if is_user:
            bx = W - MARGIN - bw
        else:
            bx = MARGIN

        # Draw bubble
        bubble_col = pal["bubble_out"] if is_user else pal["bubble_in"]
        rounded_rect(draw, [bx, y, bx + bw, y + bh + r["btn_extra"]],
                     radius=14, fill=bubble_col)

        # Bubble tail nub
        if is_user:
            draw.polygon([(bx+bw, y+bh-18), (bx+bw+6, y+bh-10),
                           (bx+bw, y+bh-8)], fill=bubble_col)
        else:
            draw.polygon([(bx, y+bh-18), (bx-6, y+bh-10),
                           (bx, y+bh-8)], fill=bubble_col)

        # Text lines
        text_col = pal["text_out"] if is_user else pal["text_in"]
        ty = y + PAD_V
        line_h = font_md.size + 4
        for line in lines:
            draw.text((bx + PAD_H, ty), line, font=font_md, fill=text_col)
            ty += line_h

        # Time + ticks
        time_str = msg.get("time", "")
        tw = draw.textbbox((0,0), time_str, font=font_sm)[2]
        tx = bx + bw - PAD_H - tw - (16 if is_user else 0)
        draw.text((tx, y + bh - PAD_V - font_sm.size - 1),
                  time_str, font=font_sm, fill=pal["time"])

        if is_user and msg.get("ticks", 0) > 0:
            tick_col = pal["accent"] if msg.get("ticks", 0) == 2 else pal["time"]
            draw_checkmarks(draw, tx + tw + 3,
                            y + bh - PAD_V - font_sm.size + 1,
                            tick_col, double=(msg.get("ticks", 0) == 2))

        # Inline buttons
        if msg.get("buttons"):
            by = y + bh + 4
            for btn in msg["buttons"]:
                bbtw = draw.textbbox((0,0), btn, font=font_sm)[2]
                btn_w = bw - 8
                btn_x = bx + 4
                rounded_rect(draw, [btn_x, by, btn_x + btn_w, by + 28],
                             radius=8,
                             fill=pal["bubble_out"] if is_user else "#1e3550",
                             outline=pal["accent"], width=1)
                draw.text((btn_x + (btn_w - bbtw)//2, by + 7),
                          btn, font=font_sm, fill=pal["accent"])
                by += 34

        y += bh + r["btn_extra"] + 10

    # ── Input bar ────────────────────────────────────────────────────────────
    draw.rectangle([0, H-56, W, H], fill=pal["input_bar"])
    rounded_rect(draw, [50, H-44, W-58, H-12], radius=20, fill=pal["bg"])
    draw.text((66, H-36), "Message", font=font_md, fill=pal["text_meta"])

    img.save(os.path.join(OUT, filename))
    print(f"  saved {filename}  ({W}×{H})")


# ════════════════════════════════════════════════════════════════════════════
#  TELEGRAM SCREENSHOTS
# ════════════════════════════════════════════════════════════════════════════

# 1. Conversation + long-term memory
make_image(TG, [
    {"role": "agent", "text": "Hey! Good morning. You have a meeting with the design team at 2pm today — I set that reminder last week when you asked.", "time": "9:41", "system_label": "Today"},
    {"role": "user",  "text": "Nice catch. Can you also summarise what we decided about the auth refactor?", "time": "9:42", "ticks": 2},
    {"role": "agent", "text": "From our conversation on March 18: you decided to replace the JWT middleware with a short-lived token + refresh-token pattern, targeting the /api/auth routes first. The deadline you mentioned was end of Q1.", "time": "9:42"},
    {"role": "user",  "text": "Perfect. Remind me again at 1:45pm.", "time": "9:43", "ticks": 2},
    {"role": "agent", "text": "Done — reminder set for 1:45 PM: \"Meeting with design team + auth refactor deadline approaching.\"", "time": "9:43"},
], "MinaClaw", "online", "M", "tg_memory.png")

# 2. Model switching
make_image(TG, [
    {"role": "user",  "text": "/model anthropic", "time": "10:12", "ticks": 2},
    {"role": "agent", "text": "Switched to Anthropic — claude-sonnet-4-6. All further messages in this session will use Claude.", "time": "10:12"},
    {"role": "user",  "text": "What's the best way to structure a multi-tenant Postgres schema?", "time": "10:13", "ticks": 2},
    {"role": "agent", "text": "Three common patterns:\n\n1. Row-level tenancy — add tenant_id to every table. Simple, good for small tenants.\n\n2. Schema-per-tenant — each tenant gets its own Postgres schema. Strong isolation, harder migrations.\n\n3. Database-per-tenant — maximum isolation, high ops overhead. Usually only needed for compliance.", "time": "10:13"},
    {"role": "user",  "text": "/model gemini", "time": "10:15", "ticks": 2},
    {"role": "agent", "text": "Switched to Google Gemini — gemini-2.5-flash.", "time": "10:15"},
], "MinaClaw", "online", "M", "tg_model_switch.png")

# 3. Command approval (inline buttons)
make_image(TG, [
    {"role": "user",  "text": "Check which Docker containers are running on my machine", "time": "11:30", "ticks": 2},
    {"role": "agent", "text": "I'll check the running containers on your host:", "time": "11:30"},
    {"role": "agent", "text": "Run on host:\n`docker ps --format \"table {{.Names}}\\t{{.Status}}\"`",
     "time": "11:30",
     "buttons": ["✅  Run it", "🔁  Always this session", "❌  Cancel"]},
    {"role": "user",  "text": "✅  Run it", "time": "11:30", "ticks": 2},
    {"role": "agent", "text": "NAMES                  STATUS\nsmartproject-backend   Up 2 hours\nsmartproject-db        Up 2 hours\nsmartproject-mqtt      Up 2 hours\nminaclaw-daemon        Up 14 hours", "time": "11:30"},
], "MinaClaw", "online", "M", "tg_approval.png")

# 4. /learn skill generation
make_image(TG, [
    {"role": "user",  "text": "/learn https://api.stripe.com/docs", "time": "14:05", "ticks": 2},
    {"role": "agent", "text": "Opening page with browser...", "time": "14:05"},
    {"role": "agent", "text": "Read 4,200 characters from stripe.com. Generating skill file...", "time": "14:06"},
    {"role": "agent", "text": "Skill saved: /app/skills/stripe_skill.md\n\nCovers: authentication (Bearer token), core objects (PaymentIntent, Customer, Subscription), key endpoints, and webhook verification. I'll use this automatically next time you ask about Stripe.", "time": "14:06"},
    {"role": "user",  "text": "Now create a payment intent for $49.99 USD", "time": "14:07", "ticks": 2},
    {"role": "agent", "text": "Using my Stripe skill — I'll need your secret key from config. Running:\n`curl -s -X POST https://api.stripe.com/v1/payment_intents ...`", "time": "14:07"},
], "MinaClaw", "online", "M", "tg_learn.png")

# ════════════════════════════════════════════════════════════════════════════
#  WHATSAPP SCREENSHOTS
# ════════════════════════════════════════════════════════════════════════════

# 5. WhatsApp — general chat + memory
make_image(WA, [
    {"role": "user",  "text": "Hey, what was the name of that JS library I asked you about last week?", "time": "18:22", "ticks": 2, "system_label": "Today"},
    {"role": "agent", "text": "You were asking about Zod — the TypeScript-first schema validation library. You mentioned you wanted to use it for validating API request bodies in your Express backend.", "time": "18:22"},
    {"role": "user",  "text": "Yes! Can you give me a quick example for validating a POST body?", "time": "18:23", "ticks": 2},
    {"role": "agent", "text": "Sure:\n\nimport { z } from 'zod';\n\nconst Body = z.object({\n  email: z.string().email(),\n  age: z.number().min(18),\n});\n\napp.post('/register', (req, res) => {\n  const result = Body.safeParse(req.body);\n  if (!result.success) return res.status(400).json(result.error);\n  // result.data is typed and validated\n});", "time": "18:23"},
    {"role": "user",  "text": "Perfect. Save that I'm using Zod in this project.", "time": "18:24", "ticks": 2},
    {"role": "agent", "text": "Noted — I've updated your memory: you're using Zod for request validation in your Express backend.", "time": "18:24"},
], "MinaClaw", "online", "M", "wa_chat.png", header_color="#1f2c33")

# 6. WhatsApp — voice note + scheduling
make_image(WA, [
    {"role": "user",  "text": "🎤  Voice message  (0:12)", "time": "20:03", "ticks": 2, "system_label": "Today"},
    {"role": "agent", "text": "Transcribed: \"Can you remind me tomorrow morning at 8am to submit the project proposal and also check if the staging server is still up?\"\n\n✅ Two reminders set:\n— 8:00 AM: Submit project proposal\n— 8:00 AM: Check staging server status", "time": "20:03"},
    {"role": "user",  "text": "Also, what time is it in Tokyo right now?", "time": "20:04", "ticks": 2},
    {"role": "agent", "text": "It's 4:04 AM on Tuesday in Tokyo (JST, UTC+9).", "time": "20:04"},
    {"role": "user",  "text": "Thanks. Good night!", "time": "20:05", "ticks": 2},
    {"role": "agent", "text": "Good night! I'll send those reminders at 8 AM your time. 🌙", "time": "20:05"},
], "MinaClaw", "online", "M", "wa_voice.png", header_color="#1f2c33")

print("\nAll screenshots saved to docs/screenshots/")
