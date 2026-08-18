#!/usr/bin/env python3
"""最小ブートセクタ Stage B(画面を1色で塗る)のバイト列を生成する。

Stage A に続いて、グラフィック画面を単色で塗る。
使う仕組みは IOCS ではなく、px68k(このプロジェクトが動かすコア本体)のソースを
実測して確認したメモリマップ:

  $E80028.B  CRTC R20 下位バイト。bit3=1 で GVRAM の読み書きが「65536色 1ページ」の
             アドレッシングになる(px68k-libretro/x68k/gvram.c: GVRAM_Read/Write の
             `CRTC_Regs[0x28] & 8` で type=4 に分岐)
  $E82401.B  Video Controller R0 下位バイト。下位2bit=3 で「65536色」の**合成側**の
             モードになる(px68k-libretro/libretro/windraw.c: WinDraw_DrawLine の
             `switch(VCReg0[1]&3) case 3`)。上の CRTC R20 とは別レジスタで、
             アドレッシングと画面合成が別々に「65536色」を選ばないと映らない
  $E82601.B  Video Controller R2 の下位バイト。下位4bitのいずれか(ここでは bit0)が
             立っていないと 65536色グラフィック面の描画が呼ばれない
             (`if (VCReg2[1]&15) Grp_DrawLine16();`)
  $C00000〜  グラフィック VRAM。type=4(65536色)では 16bit の色値をそのまま
             1ワード=1ドットとして書き込む(パレット非経由)。512x512dot ぶん
             = 0x80000 バイト = 0x40000 ワード

備考: WinDraw_DrawLine は当初 grep で「存在しない」と誤判定した。原因は
windraw.c が CP932 コメントを含み、NEL(0x85)相当のバイト列で grep が行を
無言でスキップしたため([[feedback_grep_silently_skips_nel_lines]] と同種の罠)。
node で latin1 として読み直して確認した。
"""
import struct
import sys
from pathlib import Path

SECTOR_SIZE = 1024
TOTAL_SECTORS = 1232
IMAGE_SIZE = SECTOR_SIZE * TOTAL_SECTORS


def u16(v: int) -> bytes:
    return struct.pack(">H", v & 0xFFFF)


def u32(v: int) -> bytes:
    return struct.pack(">I", v & 0xFFFFFFFF)


def build_stage_b(fill_color: int = 0xFFFF) -> bytes:
    code = bytearray()

    # +0x00: BRA.S -> 0x0A
    code += bytes([0x60, 0x08])
    assert len(code) == 0x02

    # +0x02: 識別文字列8バイト
    code += b"X68DEVB0"
    assert len(code) == 0x0A

    # +0x0A: LEA $0000B000,A7  (スタック。Stage A と同じ)
    code += bytes([0x4F, 0xF9]) + u32(0x0000B000)
    assert len(code) == 0x10

    # +0x10: MOVE.B #$08,$E80028.L  (CRTC R20下位=$08 → GVRAMアドレッシングを65536色1ページに)
    code += bytes([0x13, 0xFC]) + u16(0x0008) + u32(0x00E80028)
    assert len(code) == 0x18

    # +0x18: MOVE.B #$03,$E82401.L  (VC R0下位2bit=3 → 合成側も65536色モードに)
    code += bytes([0x13, 0xFC]) + u16(0x0003) + u32(0x00E82401)
    assert len(code) == 0x20

    # +0x20: MOVE.B #$01,$E82601.L  (VC R2下位バイト bit0=1 → 65536色グラフィック面の描画を許可)
    code += bytes([0x13, 0xFC]) + u16(0x0001) + u32(0x00E82601)
    assert len(code) == 0x28

    # +0x28: LEA $00C00000,A0  (グラフィックVRAM先頭)
    code += bytes([0x41, 0xF9]) + u32(0x00C00000)
    assert len(code) == 0x2E

    # +0x2E: MOVE.L #$00040000,D1  (0x80000バイト / 2 = 0x40000ワード)
    code += bytes([0x22, 0x3C]) + u32(0x00040000)
    assert len(code) == 0x34

    # +0x34: MOVE.W #fill_color,(A0)+   ループ先頭
    loop_addr = len(code)
    code += bytes([0x30, 0xFC]) + u16(fill_color)
    assert len(code) == 0x38

    # +0x38: SUBQ.L #1,D1
    code += bytes([0x53, 0x81])
    assert len(code) == 0x3A

    # +0x3A: BNE.S loop_addr
    bne_pc = len(code)
    disp = loop_addr - (bne_pc + 2)
    assert -128 <= disp <= 127
    code += bytes([0x66, disp & 0xFF])
    assert len(code) == 0x3C

    # +0x3C: BRA.S *  (塗り終わったら無限ループ)
    code += bytes([0x60, 0xFE])
    assert len(code) == 0x3E

    assert len(code) <= SECTOR_SIZE
    code.extend(bytes(SECTOR_SIZE - len(code)))
    assert len(code) == SECTOR_SIZE

    image = bytes(code) + bytes(SECTOR_SIZE * (TOTAL_SECTORS - 1))
    assert len(image) == IMAGE_SIZE
    return image


def main() -> None:
    out_path = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parent.parent / "build" / "stage_b.xdf"
    fill_color = int(sys.argv[2], 0) if len(sys.argv) > 2 else 0xFFFF
    out_path.parent.mkdir(parents=True, exist_ok=True)
    image = build_stage_b(fill_color)
    out_path.write_bytes(image)
    print(f"wrote {out_path} ({len(image)} bytes) fill_color=0x{fill_color:04X}")


if __name__ == "__main__":
    main()
