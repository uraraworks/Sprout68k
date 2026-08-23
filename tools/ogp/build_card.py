# SNS のカード画像(og:image)を作る。1200x630。
#
# 中身は「何ができるか」が一目で分かること。ロゴと一行の説明、そして
# **実際に動かして撮った作例の画面**を並べる（作った物の見た目がいちばん強い）。
# 画面写真は ide/samples/shots/ のもので、作例を直せばこの画像も作り直す。
from PIL import Image, ImageDraw, ImageFont
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
W, H = 1200, 630
BG = (24, 27, 34)
FG = (248, 250, 252)
DIM = (156, 163, 175)
ACCENT = (56, 189, 248)

FONT = "/System/Library/Fonts/Hiragino Sans GB.ttc"
def font(size, index=1):
    return ImageFont.truetype(FONT, size, index=index)

card = Image.new("RGB", (W, H), BG)
draw = ImageDraw.Draw(card)

# 左上: ロゴ
logo = Image.open(ROOT / "ide/icons/sprout68k-192.png").convert("RGBA").resize((96, 96), Image.LANCZOS)
card.paste(logo, (64, 56), logo)

draw.text((176, 62), "Sprout68k", font=font(60), fill=FG)
draw.text((178, 132), "X68000 / C", font=font(24), fill=ACCENT)

# 説明
draw.text((64, 196), "ブラウザだけで、X68000 のプログラムを", font=font(38), fill=FG)
draw.text((64, 248), "C で書いて、すぐ動かせる入門環境。", font=font(38), fill=FG)
draw.text((64, 314), "インストール不要 ／ 作ったものは URL で配れる", font=font(26), fill=DIM)

# 右下: 作例の画面を並べる（実際に動かして撮ったもの）
shots = ["shapes", "breakout", "life"]
size = 168
gap = 18
total = size * len(shots) + gap * (len(shots) - 1)
x0 = W - total - 64
y0 = H - size - 76
for index, name in enumerate(shots):
    shot = Image.open(ROOT / f"ide/samples/shots/{name}.png").convert("RGB").resize((size, size), Image.NEAREST)
    x = x0 + index * (size + gap)
    draw.rectangle([x - 2, y0 - 2, x + size + 1, y0 + size + 1], outline=(51, 65, 85))
    card.paste(shot, (x, y0))
draw.text((x0, y0 + size + 12), "同梱の作例（実際に動かして撮影）", font=font(20), fill=DIM)

# 下辺のアクセント
draw.rectangle([0, H - 8, W, H], fill=ACCENT)

out = ROOT / "ide/icons/ogp-card.png"
card.save(out, optimize=True)
print(f"{out.relative_to(ROOT)} {card.size[0]}x{card.size[1]} {out.stat().st_size} バイト")
