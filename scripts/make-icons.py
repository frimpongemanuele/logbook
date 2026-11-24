# Generates the JimLogs icons (3 concepts + the chosen one in all sizes). Run: python3 scripts/make-icons.py
from PIL import Image, ImageDraw
import math, os
S = 2048  # supersampled canvas

def draw_j(d, cx, top, bot, rm, w, col):
    """A 'J': stem centred on cx from top to bot, then a half-ring of centre-line radius rm hooking to the left."""
    d.rectangle([cx - w/2, top, cx + w/2, bot], fill=col)
    hx = cx - rm
    d.arc([hx - rm - w/2, bot - rm - w/2, hx + rm + w/2, bot + rm + w/2], 0, 180, fill=col, width=int(w))
    d.ellipse([hx - rm - w/2, bot - w/2, hx - rm + w/2, bot + w/2], fill=col)   # round the hook's tip
    d.ellipse([cx - w/2, top - w/2, cx + w/2, top + w/2], fill=col) if False else None

def concept_a(bg, accent, fg="#ffffff", inset=0.0):
    im = Image.new("RGB", (S, S), bg); d = ImageDraw.Draw(im)
    k = 1 - inset*2; o = S*inset
    def X(v): return o + v*k
    # barbell across the top of the J
    by = X(S*0.30); bh = S*0.05*k
    d.rounded_rectangle([X(S*0.14), by - bh/2, X(S*0.86), by + bh/2], radius=bh/2, fill=fg)
    for x, wd, ht in [(0.18, .05, .20), (0.245, .04, .15), (0.755, .04, .15), (0.80, .05, .20)]:
        d.rounded_rectangle([X(S*x), by - S*ht*k/2, X(S*(x+wd)), by + S*ht*k/2], radius=S*.012*k, fill=accent)
    w = S*0.12*k; cx = X(S*0.62); draw_j(d, cx, by, X(S*0.60), S*0.15*k, w, fg)
    return im

def concept_b(bg, accent, inset=0.0):
    """Rising bars (progression) forming a J-like hook."""
    im = Image.new("RGB", (S, S), bg); d = ImageDraw.Draw(im)
    k = 1 - inset*2; o = S*inset
    X = lambda v: o + v*k
    for i, h in enumerate([.22, .34, .46, .60]):
        x = .20 + i*.17; d.rounded_rectangle([X(S*x), X(S*(.80-h)), X(S*(x+.12)), X(S*.80)], radius=S*.03*k, fill=accent if i == 3 else "#ffffff")
    return im

def concept_c(bg, accent, inset=0.0):
    """Big lime plate with a dark J."""
    im = Image.new("RGB", (S, S), bg); d = ImageDraw.Draw(im)
    k = 1 - inset*2; c = S/2; R = S*.40*k
    d.ellipse([c-R, c-R, c+R, c+R], fill=accent)
    w = S*.11*k; draw_j(d, c + R*.22, c - R*.55, c + R*.22, R*.34, w, bg)
    return im

LIVE = ("#111114", "#c6ff3d"); BETA = ("#111114", "#ffb02e")
def save(im, path, size): im.resize((size, size), Image.LANCZOS).save(path)

def build(dirn, bg, accent):
    os.makedirs(dirn, exist_ok=True)
    full = concept_a(bg, accent)
    save(full, f"{dirn}/apple-touch-icon.png", 180); save(full, f"{dirn}/icon-192.png", 192); save(full, f"{dirn}/icon-512.png", 512)
    save(concept_a(bg, accent, inset=0.10), f"{dirn}/icon-maskable-512.png", 512)

if __name__ == "__main__":
    root = os.path.join(os.path.dirname(__file__), "..")
    build(f"{root}/web/icons", *LIVE); build(f"{root}/web/icons-beta", *BETA)
    sheet = Image.new("RGB", (3*420, 440), "#222")
    for i, f in enumerate([concept_a, concept_b, concept_c]):
        sheet.paste(f(*LIVE).resize((400, 400), Image.LANCZOS), (i*420+10, 20))
    sheet.save("/tmp/icon-options.png")
