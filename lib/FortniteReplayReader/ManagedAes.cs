namespace FortniteReplayReader;

/// <summary>
/// AES-ECB decryption (PKCS7) in plain C#. The browser (WebAssembly) build of .NET has no AES-ECB, so the web
/// version of ChestCounter decrypts the replay chunks with this instead of <c>System.Security.Cryptography.Aes</c>.
/// Decryption only, 128/192/256-bit keys. Not constant time: fine for reading a local file with its own key.
/// </summary>
public static class ManagedAes
{
    private static readonly byte[] Sbox = new byte[256];
    private static readonly byte[] InvSbox = new byte[256];
    private static readonly uint[] Td0 = new uint[256], Td1 = new uint[256], Td2 = new uint[256], Td3 = new uint[256];

    static ManagedAes()
    {
        // S-box from the multiplicative inverse in GF(2^8) followed by the affine transform.
        byte p = 1, q = 1;
        do
        {
            p = (byte)(p ^ (p << 1) ^ ((p & 0x80) != 0 ? 0x1B : 0));
            q ^= (byte)(q << 1);
            q ^= (byte)(q << 2);
            q ^= (byte)(q << 4);
            if ((q & 0x80) != 0) q ^= 0x09;
            var x = (byte)(q ^ Rotl8(q, 1) ^ Rotl8(q, 2) ^ Rotl8(q, 3) ^ Rotl8(q, 4));
            Sbox[p] = (byte)(x ^ 0x63);
        } while (p != 1);
        Sbox[0] = 0x63;

        for (var i = 0; i < 256; i++)
        {
            InvSbox[Sbox[i]] = (byte)i;
        }
        for (var i = 0; i < 256; i++)
        {
            var s = InvSbox[i];
            var t = ((uint)Mul(s, 14) << 24) | ((uint)Mul(s, 9) << 16) | ((uint)Mul(s, 13) << 8) | Mul(s, 11);
            Td0[i] = t;
            Td1[i] = (t >> 8) | (t << 24);
            Td2[i] = (t >> 16) | (t << 16);
            Td3[i] = (t >> 24) | (t << 8);
        }
    }

    private static byte Rotl8(byte v, int n) => (byte)((v << n) | (v >> (8 - n)));

    private static byte Mul(byte a, byte b)
    {
        byte r = 0;
        while (b != 0)
        {
            if ((b & 1) != 0) r ^= a;
            a = (byte)((a << 1) ^ ((a & 0x80) != 0 ? 0x1B : 0));
            b >>= 1;
        }
        return r;
    }

    private static uint SubWord(uint w) =>
        ((uint)Sbox[w >> 24] << 24) | ((uint)Sbox[(w >> 16) & 0xFF] << 16) | ((uint)Sbox[(w >> 8) & 0xFF] << 8) | Sbox[w & 0xFF];

    /// <summary>Round keys of the equivalent inverse cipher, first decryption round first.</summary>
    private static uint[] DecryptionKey(ReadOnlySpan<byte> key, out int rounds)
    {
        var nk = key.Length / 4;
        if (key.Length is not (16 or 24 or 32))
        {
            throw new ArgumentException("AES key must be 16, 24 or 32 bytes.", nameof(key));
        }
        rounds = nk + 6;
        var total = 4 * (rounds + 1);
        var w = new uint[total];
        for (var i = 0; i < nk; i++)
        {
            w[i] = ((uint)key[4 * i] << 24) | ((uint)key[4 * i + 1] << 16) | ((uint)key[4 * i + 2] << 8) | key[4 * i + 3];
        }
        uint rcon = 1;
        for (var i = nk; i < total; i++)
        {
            var t = w[i - 1];
            if (i % nk == 0)
            {
                t = SubWord((t << 8) | (t >> 24)) ^ (rcon << 24);
                rcon = (rcon << 1) ^ ((rcon & 0x80) != 0 ? 0x11Bu : 0);
            }
            else if (nk > 6 && i % nk == 4)
            {
                t = SubWord(t);
            }
            w[i] = w[i - nk] ^ t;
        }

        var d = new uint[total];
        for (var r = 0; r <= rounds; r++)
        {
            for (var c = 0; c < 4; c++)
            {
                var v = w[4 * (rounds - r) + c];
                if (r != 0 && r != rounds)
                {
                    // InvMixColumns of the round key.
                    v = Td0[Sbox[v >> 24]] ^ Td1[Sbox[(v >> 16) & 0xFF]] ^ Td2[Sbox[(v >> 8) & 0xFF]] ^ Td3[Sbox[v & 0xFF]];
                }
                d[4 * r + c] = v;
            }
        }
        return d;
    }

    /// <summary>Decrypts <paramref name="data"/> (a multiple of 16 bytes) and removes the PKCS7 padding.</summary>
    public static byte[] DecryptEcbPkcs7(ReadOnlySpan<byte> key, ReadOnlySpan<byte> data)
    {
        if (data.Length == 0 || data.Length % 16 != 0)
        {
            throw new System.Security.Cryptography.CryptographicException("The input data is not a complete block.");
        }
        var rk = DecryptionKey(key, out var rounds);
        var output = new byte[data.Length];

        for (var offset = 0; offset < data.Length; offset += 16)
        {
            var s0 = Load(data, offset) ^ rk[0];
            var s1 = Load(data, offset + 4) ^ rk[1];
            var s2 = Load(data, offset + 8) ^ rk[2];
            var s3 = Load(data, offset + 12) ^ rk[3];
            var k = 4;
            for (var r = 1; r < rounds; r++, k += 4)
            {
                var t0 = Td0[s0 >> 24] ^ Td1[(s3 >> 16) & 0xFF] ^ Td2[(s2 >> 8) & 0xFF] ^ Td3[s1 & 0xFF] ^ rk[k];
                var t1 = Td0[s1 >> 24] ^ Td1[(s0 >> 16) & 0xFF] ^ Td2[(s3 >> 8) & 0xFF] ^ Td3[s2 & 0xFF] ^ rk[k + 1];
                var t2 = Td0[s2 >> 24] ^ Td1[(s1 >> 16) & 0xFF] ^ Td2[(s0 >> 8) & 0xFF] ^ Td3[s3 & 0xFF] ^ rk[k + 2];
                var t3 = Td0[s3 >> 24] ^ Td1[(s2 >> 16) & 0xFF] ^ Td2[(s1 >> 8) & 0xFF] ^ Td3[s0 & 0xFF] ^ rk[k + 3];
                s0 = t0; s1 = t1; s2 = t2; s3 = t3;
            }
            Store(output, offset, Last(s0, s3, s2, s1) ^ rk[k]);
            Store(output, offset + 4, Last(s1, s0, s3, s2) ^ rk[k + 1]);
            Store(output, offset + 8, Last(s2, s1, s0, s3) ^ rk[k + 2]);
            Store(output, offset + 12, Last(s3, s2, s1, s0) ^ rk[k + 3]);
        }

        int pad = output[^1];
        if (pad is < 1 or > 16)
        {
            throw new System.Security.Cryptography.CryptographicException("Padding is invalid and cannot be removed.");
        }
        for (var i = output.Length - pad; i < output.Length; i++)
        {
            if (output[i] != pad)
            {
                throw new System.Security.Cryptography.CryptographicException("Padding is invalid and cannot be removed.");
            }
        }
        return output.AsSpan(0, output.Length - pad).ToArray();
    }

    private static uint Last(uint a, uint b, uint c, uint d) =>
        ((uint)InvSbox[a >> 24] << 24) | ((uint)InvSbox[(b >> 16) & 0xFF] << 16) | ((uint)InvSbox[(c >> 8) & 0xFF] << 8) | InvSbox[d & 0xFF];

    private static uint Load(ReadOnlySpan<byte> b, int i) => ((uint)b[i] << 24) | ((uint)b[i + 1] << 16) | ((uint)b[i + 2] << 8) | b[i + 3];

    private static void Store(byte[] b, int i, uint v)
    {
        b[i] = (byte)(v >> 24); b[i + 1] = (byte)(v >> 16); b[i + 2] = (byte)(v >> 8); b[i + 3] = (byte)v;
    }
}
