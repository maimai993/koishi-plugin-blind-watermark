#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""koishi-plugin-blind-watermark 的 Python 桥。

把 guofei9987/blind_watermark 封装成一个「参数进、JSON 出」的命令行工具，
方便 Koishi(Node) 侧通过子进程调用。所有输出都是单行 JSON（stdout），
日志一律走 stderr，避免污染协议。

用法：
    python bwm_cli.py info
    python bwm_cli.py capacity --img carrier.png
    python bwm_cli.py embed  --img carrier.png --out out.png --text "水印内容" [--bits 512]
    python bwm_cli.py embed  --img carrier.png --out out.png --logo logo.png
    python bwm_cli.py extract --img out.png [--bits 512,256,128]
    python bwm_cli.py extract --img out.png --logo logo.png --out-wm wm.png
    python bwm_cli.py extract --img cropped.png --original original.png   # 被裁剪过：用原图复原画布再提取
    python bwm_cli.py extract --img cropped.png --canvas 1108x738 --offset 40,20
    python bwm_cli.py locate  --img cropped.png --original original.png   # 只做定位

协议（文字水印，默认 mode=packet）：
    水印被编码成固定长度的 bit 流，格式为
        [magic 1B][长度 1B][校验 1B][utf-8 正文 ...][0 填充]
    bit 流总长固定（--bits，默认 512），因此提取时不需要用户记住任何长度，
    插件会按几个候选位宽依次尝试并用 magic + 校验确认。
"""
import argparse
import json
import os
import re
import sys
import time
import traceback

# 让 python/ 目录下的 vendored 包可以被导入（不依赖 pip 安装）
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# Windows 控制台默认 GBK，强制 UTF-8 输出
try:
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')
except Exception:
    pass

# numpy 由 import_cv2_numpy() 赋值，模块级辅助函数（画布复原等）也要用它
np = None

MAGIC = 0xB7
HEADER_BYTES = 3  # magic + length + checksum
DEFAULT_BITS = 512
CANDIDATE_BITS = (512, 1024, 256, 2048, 128, 64)


def out(obj):
    """输出协议 JSON（单行）并退出。"""
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def fail(code, message, **extra):
    payload = {'ok': False, 'code': code, 'message': message}
    payload.update(extra)
    out(payload)
    sys.exit(0)


def log(message):
    sys.stderr.write(str(message) + "\n")


def load_lib():
    """导入 vendored 的 blind_watermark，返回 (WaterMark, __version__)。"""
    try:
        from blind_watermark import WaterMark
        from blind_watermark.version import __version__, bw_notes
    except ImportError as error:
        fail('missing-deps', '无法导入 blind_watermark(%s)，请检查 python/ 目录是否完整' % error)
    except Exception as error:  # 多半是 numpy / cv2 / pywt 缺失
        fail('missing-deps', '导入 blind_watermark 依赖失败：%s：%s' % (type(error).__name__, error),
             hint='pip install numpy opencv-python PyWavelets')
    # 关掉库自带的欢迎横幅，保持 stdout 干净
    try:
        bw_notes.close()
    except Exception:
        pass
    return WaterMark, __version__


def import_cv2_numpy():
    global np
    try:
        import numpy
        import cv2
    except Exception as error:
        fail('missing-deps', '缺少 numpy / opencv-python：%s' % error,
             hint='pip install numpy opencv-python PyWavelets')
    np = numpy
    return np, cv2


def read_image(path, cv2):
    if not path or not os.path.exists(path):
        fail('bad-image', '找不到图片文件：%s' % path)
    img = cv2.imread(path, flags=cv2.IMREAD_UNCHANGED)
    if img is None:
        fail('bad-image', '图片无法解析：%s' % path)
    return img


def capacity_of(shape):
    """按 bwm_core 的算法估算可嵌入的 bit 数（block_num）。"""
    height, width = shape[0], shape[1]
    ca_h, ca_w = (height + 1) // 2, (width + 1) // 2
    return (ca_h // 4) * (ca_w // 4)


def parse_size(value):
    """把 1108x738 解析成 (宽, 高)"""
    match = re.match(r'^\s*(\d+)\s*[xX*×]\s*(\d+)\s*$', str(value or ''))
    if not match:
        fail('bad-arg', '--canvas 格式应为 宽x高，例如 1108x738')
    return int(match.group(1)), int(match.group(2))


def parse_offset(value):
    """把 40,20 解析成 (x, y)"""
    match = re.match(r'^\s*(\d+)\s*[,，]\s*(\d+)\s*$', str(value or ''))
    if not match:
        fail('bad-arg', '--offset 格式应为 x,y，例如 40,20')
    return int(match.group(1)), int(match.group(2))


def to_gray(img, cv2):
    if img.ndim == 2:
        return img
    if img.shape[2] == 4:
        return cv2.cvtColor(img, cv2.COLOR_BGRA2GRAY)
    return cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)


def to_bgr(img, cv2):
    if img.ndim == 2:
        return cv2.cvtColor(img, cv2.COLOR_GRAY2BGR)
    if img.shape[2] == 4:
        return cv2.cvtColor(img, cv2.COLOR_BGRA2BGR)
    return img


def locate_in_original(cropped, original, cv2, scale_search=False, min_score=0.9):
    """在被裁剪的图和「原图」之间做模板匹配，找出裁剪块在原图里的位置（必要时还会搜缩放）"""
    gray_original = to_gray(original, cv2)
    gray_cropped = to_gray(cropped, cv2)

    def match(scale):
        width = max(1, int(round(gray_cropped.shape[1] * scale)))
        height = max(1, int(round(gray_cropped.shape[0] * scale)))
        if height > gray_original.shape[0] or width > gray_original.shape[1]:
            return None
        interpolation = cv2.INTER_AREA if scale < 1 else cv2.INTER_LINEAR
        template = cv2.resize(gray_cropped, (width, height), interpolation=interpolation)
        result = cv2.matchTemplate(gray_original, template, cv2.TM_CCOEFF_NORMED)
        _, score, _, loc = cv2.minMaxLoc(result)
        return {'x': int(loc[0]), 'y': int(loc[1]), 'w': width, 'h': height,
                'score': float(score), 'scale': float(scale)}

    best = match(1.0)
    if scale_search and (best is None or best['score'] < min_score):
        for scale in np.linspace(0.3, 2.0, 35):
            got = match(float(scale))
            if got and (best is None or got['score'] > best['score']):
                best = got
        if best:
            low = max(0.2, best['scale'] - 0.06)
            high = min(2.4, best['scale'] + 0.06)
            for scale in np.linspace(low, high, 25):
                got = match(float(scale))
                if got and got['score'] > best['score']:
                    best = got
    return best


def build_canvas(cropped, canvas_shape, loc, cv2):
    """把裁剪块放回原图大小的画布上（没覆盖到的地方填 0）：水印的分块网格是按原始尺寸排的，位置对上就能提取"""
    height, width = canvas_shape[0], canvas_shape[1]
    canvas = np.zeros((height, width, 3), np.uint8)
    piece = cropped
    if abs(loc['scale'] - 1.0) > 1e-3:
        piece = cv2.resize(cropped, (loc['w'], loc['h']))
    piece = to_bgr(piece, cv2)
    y, x = loc['y'], loc['x']
    if y + piece.shape[0] > height or x + piece.shape[1] > width:
        fail('bad-arg', '裁剪块超出原图范围，请检查原图/尺寸是否正确')
    canvas[y:y + piece.shape[0], x:x + piece.shape[1]] = piece
    return canvas


def maybe_resize(img, max_size, cv2):
    """把长边限制在 max_size 内（只在 embed 时用），返回 (img, scaled_from)。"""
    if not max_size or max_size <= 0:
        return img, None
    height, width = img.shape[:2]
    longest = max(height, width)
    if longest <= max_size:
        return img, None
    ratio = max_size / float(longest)
    new_size = (max(1, int(round(width * ratio))), max(1, int(round(height * ratio))))
    return cv2.resize(img, new_size, interpolation=cv2.INTER_AREA), (width, height)


def text_to_bits(text, bits):
    """把文字编码成固定长度的 bit 列表（MSB first）。"""
    payload = text.encode('utf-8')
    limit = bits // 8 - HEADER_BYTES
    if len(payload) > limit:
        fail('too-long', '水印文字太长：%d 字节，当前位宽 %d 最多 %d 字节（可提高 --bits）'
             % (len(payload), bits, limit), maxBytes=limit)
    checksum = (len(payload) + sum(payload)) & 0xFF
    data = bytes([MAGIC, len(payload), checksum]) + payload
    bit_list = []
    for byte in data:
        for shift in range(7, -1, -1):
            bit_list.append((byte >> shift) & 1)
    if len(bit_list) > bits:
        fail('too-long', '水印内容超出位宽 %d' % bits)
    bit_list.extend([0] * (bits - len(bit_list)))
    return bit_list


def bits_to_text(bit_array):
    """从提取结果里解析文字，失败返回 None。"""
    values = [1 if bit else 0 for bit in bit_array]
    if len(values) < HEADER_BYTES * 8:
        return None
    raw = bytearray()
    for index in range(0, HEADER_BYTES * 8, 8):
        byte = 0
        for bit in values[index:index + 8]:
            byte = (byte << 1) | bit
        raw.append(byte)
    if raw[0] != MAGIC:
        return None
    length, checksum = raw[1], raw[2]
    max_bytes = len(values) // 8 - HEADER_BYTES
    if length == 0 or length > max_bytes:
        return None
    payload = bytearray()
    start = HEADER_BYTES * 8
    for index in range(start, start + length * 8, 8):
        byte = 0
        for bit in values[index:index + 8]:
            byte = (byte << 1) | bit
        payload.append(byte)
    if (length + sum(payload)) & 0xFF != checksum:
        return None
    try:
        return payload.decode('utf-8')
    except UnicodeDecodeError:
        return None


def cmd_info(args):
    WaterMark, version = load_lib()
    np, cv2 = import_cv2_numpy()
    try:
        import pywt
        pywt_version = pywt.__version__
    except Exception as error:
        fail('missing-deps', '缺少 PyWavelets：%s' % error, hint='pip install PyWavelets')
    out({
        'ok': True,
        'python': sys.version.split()[0],
        'blindWatermark': version,
        'numpy': np.__version__,
        'opencv': cv2.__version__,
        'pywt': pywt_version,
    })


def cmd_capacity(args):
    np, cv2 = import_cv2_numpy()
    img = read_image(args.img, cv2)
    cap = capacity_of(img.shape)
    out({'ok': True, 'capacity': cap, 'shape': [img.shape[1], img.shape[0]]})


def recover_for_extract(cropped, args, cv2, np):
    """按 --original（推荐）或 --canvas + --offset 把裁剪块放回原图大小的画布上。

    原理：水印的分块网格是按「原图尺寸」划分的，裁剪会让网格整体错位，
    所以先把裁剪块按正确的位置/尺寸放回原尺寸画布，再提取。
    """
    if args.original:
        original = read_image(args.original, cv2)
        loc = locate_in_original(cropped, original, cv2, scale_search=args.scale_search)
        if not loc:
            fail('bad-arg', '裁剪图比原图还大，定位失败；可以加 --scale-search 让插件搜一下缩放')
        canvas = build_canvas(cropped, (original.shape[0], original.shape[1]), loc, cv2)
        return {'image': canvas, 'info': {
            'mode': 'original', 'x': loc['x'], 'y': loc['y'],
            'score': round(loc['score'], 4), 'scale': round(loc['scale'], 4),
            'canvas': [original.shape[1], original.shape[0]],
        }}
    if not args.canvas:
        fail('bad-arg', '需要 --original（原图）或 --canvas（原图尺寸 宽x高）+ --offset（裁剪位置 x,y）')
    width, height = parse_size(args.canvas)
    x, y = parse_offset(args.offset or '0,0')
    loc = {'x': x, 'y': y, 'w': cropped.shape[1], 'h': cropped.shape[0], 'score': 1.0, 'scale': 1.0}
    canvas = build_canvas(cropped, (height, width), loc, cv2)
    return {'image': canvas, 'info': {
        'mode': 'canvas', 'x': x, 'y': y, 'score': 1.0, 'scale': 1.0, 'canvas': [width, height],
    }}


def cmd_locate(args):
    """只做定位：告诉调用方这张裁剪图在原图里的位置/缩放，方便自己判断"""
    np, cv2 = import_cv2_numpy()
    cropped = read_image(args.img, cv2)
    original = read_image(args.original, cv2)
    loc = locate_in_original(cropped, original, cv2, scale_search=args.scale_search)
    if not loc:
        fail('bad-arg', '定位失败：裁剪图可能比原图大（试试 --scale-search）')
    loc.update({
        'ok': True,
        'original': [original.shape[1], original.shape[0]],
        'cropped': [cropped.shape[1], cropped.shape[0]],
    })
    out(loc)


def cmd_embed(args):
    WaterMark, version = load_lib()
    np, cv2 = import_cv2_numpy()
    img = read_image(args.img, cv2)
    img, scaled_from = maybe_resize(img, args.max_size, cv2)
    capacity = capacity_of(img.shape)
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)

    mode = args.mode
    if mode == 'auto':
        mode = 'img' if args.logo else 'packet'

    if mode == 'packet':
        if not args.text:
            fail('bad-arg', '文字水印需要 --text')
        bits = int(args.bits or DEFAULT_BITS)
        if bits % 8 != 0:
            fail('bad-arg', '--bits 必须是 8 的倍数')
        if capacity <= bits:
            fail('capacity', '图片太小：最多可嵌入 %d bit，当前需要 %d bit，请换更大的图或降低 --bits'
                 % (capacity, bits), capacity=capacity, bits=bits)
        bit_list = text_to_bits(args.text, bits)
        watermark = np.array(bit_list)
    elif mode == 'str':
        # 兼容官方 CLI 的写法：位宽由库按字符串自己算，提取时需要用户提供
        if not args.text:
            fail('bad-arg', 'str 模式需要 --text')
        watermark = args.text
    elif mode == 'img':
        if not args.logo:
            fail('bad-arg', '图片水印需要 --logo')
        if not os.path.exists(args.logo):
            fail('bad-image', '找不到水印图片：%s' % args.logo)
        watermark = args.logo
    else:
        fail('bad-arg', '不支持的 mode：%s' % mode)

    if mode != 'str' and capacity <= (watermark.size if hasattr(watermark, 'size') else 0):
        fail('capacity', '图片太小：最多可嵌入 %d bit，当前水印过大' % capacity, capacity=capacity)

    started = time.time()
    try:
        bwm = WaterMark(password_wm=int(args.password_watermark), password_img=int(args.password_image))
        bwm.read_img(img=img)
        bwm.read_wm(watermark, mode='str' if mode == 'str' else 'img' if mode == 'img' else 'bit')
        bwm.embed(args.out, compression_ratio=args.compression)
    except AssertionError as error:
        fail('capacity', str(error), capacity=capacity)
    except Exception as error:
        log(traceback.format_exc())
        fail('error', '%s: %s' % (type(error).__name__, error))

    result = {
        'ok': True,
        'mode': mode,
        'out': os.path.abspath(args.out),
        'capacity': capacity,
        'bits': int(bwm.wm_bit.size) if mode != 'str' else int(len(bwm.wm_bit)),
        'size': [img.shape[1], img.shape[0]],
        'elapsed': round(time.time() - started, 3),
        'version': version,
    }
    if scaled_from:
        result['scaledFrom'] = list(scaled_from)
    out(result)


def cmd_extract(args):
    WaterMark, version = load_lib()
    np, cv2 = import_cv2_numpy()
    img = read_image(args.img, cv2)
    recovery = None
    if args.original or args.canvas:
        recovery = recover_for_extract(img, args, cv2, np)
        img = recovery['image']
    capacity = capacity_of(img.shape)

    mode = args.mode
    if mode == 'auto':
        mode = 'img' if args.logo else 'packet'

    started = time.time()

    if mode == 'packet':
        candidates = []
        for raw in (args.bits or '').split(','):
            raw = raw.strip()
            if not raw:
                continue
            try:
                candidates.append(int(raw))
            except ValueError:
                fail('bad-arg', '--bits 只能是逗号分隔的数字，例如 512,256')
        if not candidates:
            candidates = [DEFAULT_BITS] + [b for b in CANDIDATE_BITS if b != DEFAULT_BITS]
        # 位宽不能超过图片容量，否则库会直接断言失败
        usable = [b for b in candidates if b % 8 == 0 and capacity > b]
        if not usable:
            fail('capacity', '图片太小：最多可嵌入 %d bit，无法提取任何候选位宽的水印' % capacity, capacity=capacity)
        tried = []
        for bits in usable:
            try:
                bwm = WaterMark(password_wm=int(args.password_watermark), password_img=int(args.password_image))
                watermark = bwm.extract(embed_img=img, wm_shape=bits, mode='bit')
            except Exception as error:
                tried.append({'bits': bits, 'error': '%s: %s' % (type(error).__name__, error)})
                continue
            text = bits_to_text(watermark)
            tried.append({'bits': bits, 'match': text is not None})
            if text is not None:
                out({
                    'ok': True,
                    'mode': 'packet',
                    'found': True,
                    'text': text,
                    'bits': bits,
                    'capacity': capacity,
                    'size': [img.shape[1], img.shape[0]],
                    'recovered': recovery['info'] if recovery else None,
                    'elapsed': round(time.time() - started, 3),
                    'version': version,
                })
                return
        out({
            'ok': True,
            'mode': 'packet',
            'found': False,
            'message': '没有提取到有效水印（可能没打过水印、密码不对，或图片被压缩/缩放破坏了）'
                       + ('；已按原图复原画布' if recovery else '；如果这张图被裁剪过，用 --original 传原图 / bwm.recover 复原后再试'),
            'capacity': capacity,
            'tried': tried,
            'recovered': recovery['info'] if recovery else None,
            'elapsed': round(time.time() - started, 3),
        })
        return

    if mode == 'str':
        if not args.wm_shape:
            fail('bad-arg', 'str 模式需要 --wm-shape（embed 时返回的 bits）')
        try:
            bwm = WaterMark(password_wm=int(args.password_watermark), password_img=int(args.password_image))
            text = bwm.extract(embed_img=img, wm_shape=int(args.wm_shape), mode='str')
        except Exception as error:
            fail('error', '%s: %s' % (type(error).__name__, error))
        out({'ok': True, 'mode': 'str', 'found': True, 'text': text,
             'bits': int(args.wm_shape), 'elapsed': round(time.time() - started, 3)})
        return

    if mode == 'img':
        shape = args.wm_shape
        if args.logo:
            logo = read_image(args.logo, cv2)
            shape = '%dx%d' % (logo.shape[1], logo.shape[0])
        if not shape:
            fail('bad-arg', '提取图片水印需要 --wm-shape（如 64x64）或 --logo 提供尺寸')
        try:
            if 'x' in shape.lower():
                left, right = shape.lower().split('x')
                wm_shape = [int(right), int(left)]  # 库内部按 (行, 列) 用
            else:
                wm_shape = [int(shape), int(shape)]
        except ValueError:
            fail('bad-arg', '--wm-shape 格式应为 宽x高，例如 64x64')
        out_wm = args.out_wm or os.path.join(os.path.dirname(os.path.abspath(args.img)), 'extracted_wm.png')
        os.makedirs(os.path.dirname(os.path.abspath(out_wm)), exist_ok=True)
        try:
            bwm = WaterMark(password_wm=int(args.password_watermark), password_img=int(args.password_image))
            bwm.extract(embed_img=img, wm_shape=wm_shape, out_wm_name=out_wm, mode='img')
        except AssertionError as error:
            fail('capacity', str(error), capacity=capacity)
        except Exception as error:
            log(traceback.format_exc())
            fail('error', '%s: %s' % (type(error).__name__, error))
        out({'ok': True, 'mode': 'img', 'found': True, 'out': os.path.abspath(out_wm),
             'wmShape': wm_shape, 'capacity': capacity, 'elapsed': round(time.time() - started, 3)})
        return

    fail('bad-arg', '不支持的 mode：%s' % mode)


def main():
    parser = argparse.ArgumentParser(prog='bwm_cli', description='koishi-plugin-blind-watermark bridge')
    sub = parser.add_subparsers(dest='command')

    p_info = sub.add_parser('info')
    p_info.set_defaults(func=cmd_info)

    p_cap = sub.add_parser('capacity')
    p_cap.add_argument('--img', required=True)
    p_cap.set_defaults(func=cmd_capacity)

    p_embed = sub.add_parser('embed')
    p_embed.add_argument('--img', required=True)
    p_embed.add_argument('--out', required=True)
    p_embed.add_argument('--text')
    p_embed.add_argument('--logo')
    p_embed.add_argument('--mode', default='auto', choices=['auto', 'packet', 'str', 'img'])
    p_embed.add_argument('--bits', type=int, default=DEFAULT_BITS)
    p_embed.add_argument('--password-image', type=int, default=1)
    p_embed.add_argument('--password-watermark', type=int, default=1)
    p_embed.add_argument('--max-size', type=int, default=0)
    p_embed.add_argument('--compression', type=int, default=None)
    p_embed.set_defaults(func=cmd_embed)

    p_extract = sub.add_parser('extract')
    p_extract.add_argument('--img', required=True)
    p_extract.add_argument('--logo')
    p_extract.add_argument('--out-wm')
    p_extract.add_argument('--mode', default='auto', choices=['auto', 'packet', 'str', 'img'])
    p_extract.add_argument('--bits', default='')
    p_extract.add_argument('--wm-shape')
    p_extract.add_argument('--original', help='原图（没被裁剪过的那张），用于定位并复原画布')
    p_extract.add_argument('--canvas', help='原图尺寸 宽x高（没有原图文件时用这个）')
    p_extract.add_argument('--offset', help='裁剪块在原图里的位置 x,y（配合 --canvas）')
    p_extract.add_argument('--scale-search', action='store_true', help='模板匹配时同时搜索缩放比例')
    p_extract.add_argument('--password-image', type=int, default=1)
    p_extract.add_argument('--password-watermark', type=int, default=1)
    p_extract.set_defaults(func=cmd_extract)

    p_locate = sub.add_parser('locate')
    p_locate.add_argument('--img', required=True)
    p_locate.add_argument('--original', required=True)
    p_locate.add_argument('--scale-search', action='store_true')
    p_locate.set_defaults(func=cmd_locate)

    args = parser.parse_args()
    if not getattr(args, 'func', None):
        parser.print_help()
        fail('bad-arg', '缺少子命令（info / capacity / embed / extract）')
    try:
        args.func(args)
    except SystemExit:
        raise
    except Exception as error:
        log(traceback.format_exc())
        fail('error', '%s: %s' % (type(error).__name__, error))


if __name__ == '__main__':
    main()
