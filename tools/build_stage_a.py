#!/usr/bin/env python3
"""最小ブートセクタ Stage A(文字列表示)のバイト列を生成する。

68000 の生バイト列を1命令ずつ手組みする。アセンブラは使わない。
使う IOCS は実測で確認済みの $21(文字列表示)のみ。
ロードアドレス非依存にするため、スタック設定以外は PC 相対 / 自己相対のみを使う。

出力先はコマンドライン引数(省略時は build/stage_a.xdf)。
"""
import sys
import struct
from pathlib import Path

SECTOR_SIZE = 1024
TOTAL_SECTORS = 1232
IMAGE_SIZE = SECTOR_SIZE * TOTAL_SECTORS  # 1,261,568 バイト


def build_stage_a() -> bytes:
    code = bytearray()

    def emit(b: bytes, label: str) -> None:
        code.extend(b)

    # +0x00: BRA.S -> 0x0A (識別文字列8バイトを飛び越す)
    # disp = target - (pc_of_this_instruction + 2) = 0x0A - 0x02 = 0x08
    emit(bytes([0x60, 0x08]), "BRA.S +0x0A")
    assert len(code) == 0x02

    # +0x02: 識別文字列8バイト(飾り。IPL は見ていないことを検証済み)
    ident = b"X68DEVA0"
    assert len(ident) == 8
    emit(ident, "identifier")
    assert len(code) == 0x0A

    # +0x0A: LEA $0000B000,A7  (4F F9 0000B000)
    # 絶対アドレスなのでロードアドレスに依存しない(スタックは実行位置と無関係な固定RAM)。
    # 参考: 実在ディスク(検体2)と同一エンコード。Absolute Short ではなく Absolute Long
    # を使う理由: $B000 は上位ビットが立っており Absolute Short だと符号拡張されて
    # 24bit空間で $FFB000 に化けるため。
    emit(bytes([0x4F, 0xF9]) + struct.pack(">I", 0x0000B000), "LEA $B000,A7")
    assert len(code) == 0x10

    # +0x10: LEA (msg,PC),A1  (43 FA dddd)
    # displacement は拡張ワードのアドレス(+0x12)からの相対値。
    ext_word_addr = 0x12
    msg_addr = 0x1A
    disp = msg_addr - ext_word_addr
    assert disp == 0x08
    emit(bytes([0x43, 0xFA]) + struct.pack(">h", disp), "LEA (msg,PC),A1")
    assert len(code) == 0x14

    # +0x14: MOVEQ #$21,D0  (70 21)  文字列表示の機能番号
    emit(bytes([0x70, 0x21]), "MOVEQ #$21,D0")
    assert len(code) == 0x16

    # +0x16: TRAP #15  (4E 4F)  IOCS コール
    emit(bytes([0x4E, 0x4F]), "TRAP #15")
    assert len(code) == 0x18

    # +0x18: BRA.S *  (60 FE)  自分自身への無限ループ
    # disp = target(自分自身) - (pc+2) = -2 = 0xFE
    emit(bytes([0x60, 0xFE]), "BRA.S *")
    assert len(code) == 0x1A

    # +0x1A: メッセージ文字列(末尾ゼロ終端)
    msg = b"BOOT OK\x00"
    emit(msg, "message")
    assert len(code) == 0x22

    # 残りをゼロ埋めして 1024 バイト(1セクタ)にする
    assert len(code) <= SECTOR_SIZE
    code.extend(bytes(SECTOR_SIZE - len(code)))
    assert len(code) == SECTOR_SIZE

    # 残り 1231 セクタもゼロ埋めして 1,261,568 バイトの生イメージにする
    image = bytes(code) + bytes(SECTOR_SIZE * (TOTAL_SECTORS - 1))
    assert len(image) == IMAGE_SIZE
    return image


def main() -> None:
    out_path = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parent.parent / "build" / "stage_a.xdf"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    image = build_stage_a()
    out_path.write_bytes(image)
    print(f"wrote {out_path} ({len(image)} bytes)")


if __name__ == "__main__":
    main()
