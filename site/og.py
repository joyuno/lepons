"""The share card (og.png, og-en.png) for lepons.app: python site/og.py. Same layout as before, current headline."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

site = Path(__file__).resolve().parent
fonts = site.parent / 'mobile/assets/fonts'
icon = Image.open(site.parent / 'mobile/assets/icon.png').convert('RGBA')
ground, ink, muted, teal, amber, on_amber = '#cdd5e0', '#1f2328', '#3d4650', '#62b3c5', '#e8a33d', '#2a1d08'


def font(size, name='Pretendard-Bold.otf'):
    return ImageFont.truetype(str(fonts / name), size)


def fit(d, text, width, size, name='Pretendard-Bold.otf'):
    while d.textlength(text, font=font(size, name)) > width:
        size -= 2
    return font(size, name)


cards = {
    'og.png': (['여러 PC의 AI 에이전트를', '화면 하나로'], '폴더를 끌어다 놓으면 다른 PC의 AI가 읽어요'),
    'og-en.png': (['AI agents on all your PCs,', 'on one screen'], "Drag a folder over and another PC's AI reads it"),
}
for name, (lines, sub) in cards.items():
    im = Image.new('RGB', (1200, 630), ground)
    d = ImageDraw.Draw(im)
    mark = icon.resize((48, 48), Image.Resampling.LANCZOS)
    corner = Image.new('L', (48, 48), 0)
    ImageDraw.Draw(corner).rounded_rectangle((0, 0, 47, 47), radius=11, fill=255)
    im.paste(mark, (76, 64), corner)
    d.text((144, 66), 'Lepons', font=font(36), fill=ink)
    head = fit(d, max(lines, key=len), 1050, 76)
    d.text((72, 172), lines[0], font=head, fill=ink)
    d.text((72, 270), lines[1], font=head, fill=ink)
    # The icon's line: down from the top-left, round a wide corner, into the amber pill.
    d.rectangle((72, 420, 98, 470), fill=teal)
    d.arc((72, 370, 272, 570), 90, 180, fill=teal, width=26)
    d.rectangle((172, 544, 840, 570), fill=teal)
    d.text((150, 474), sub, font=fit(d, sub, 640, 26, 'Pretendard-Regular.otf'), fill=muted)
    d.rounded_rectangle((820, 470, 1120, 590), radius=28, fill=amber)
    url = font(30)
    w = d.textlength('lepons.app', font=url)
    d.text((970 - w / 2, 512), 'lepons.app', font=url, fill=on_amber)
    im.save(site / name, optimize=True)
    print(name, im.size)
