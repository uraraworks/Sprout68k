/* X68kDev の最小 C サンプル。次段のツールチェーン接続確認にも使用する。 */
extern void iocs_print(const char *message);

void main(void)
{
    iocs_print("HELLO X68000");
    for (;;) {
    }
}
