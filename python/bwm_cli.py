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

协议（文字水印，默认 mode=packet）：
    水印被编码成固定长度的 bit 流，格式为
        [magic 1B][长度 1B][校验 1B][utf-8 正文 ...][0 填充]
    bit 流总长固定（--bits，默认 512），因此提取时不需要用户记住任何长度，
    插件会按几个候选位宽依次尝试并用 magic + 校验确认。
"""
import argparse
import json
import os
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
    try:
        import numpy as np
        import cv2
    except Exception as error:
        fail('missing-deps', '缺少 numpy / opencv-python：%s' % error,
             hint='pip install numpy opencv-python PyWavelets')
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
                watermark = bwm.extract(filename=args.img, wm_shape=bits, mode='bit')
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
                    'elapsed': round(time.time() - started, 3),
                    'version': version,
                })
                return
        out({
            'ok': True,
            'mode': 'packet',
            'found': False,
            'message': '没有提取到有效水印（可能没打过水印、密码不对，或图片被压缩/缩放破坏了）',
            'capacity': capacity,
            'tried': tried,
            'elapsed': round(time.time() - started, 3),
        })
        return

    if mode == 'str':
        if not args.wm_shape:
            fail('bad-arg', 'str 模式需要 --wm-shape（embed 时返回的 bits）')
        try:
            bwm = WaterMark(password_wm=int(args.password_watermark), password_img=int(args.password_image))
            text = bwm.extract(filename=args.img, wm_shape=int(args.wm_shape), mode='str')
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
            bwm.extract(filename=args.img, wm_shape=wm_shape, out_wm_name=out_wm, mode='img')
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
    p_extract.add_argument('--password-image', type=int, default=1)
    p_extract.add_argument('--password-watermark', type=int, default=1)
    p_extract.set_defaults(func=cmd_extract)

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
