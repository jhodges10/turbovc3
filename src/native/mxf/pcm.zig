const types = @import("types.zig");

pub const PcmLayout = struct {
    valid_bits_per_sample: u32,
    stored_bits_per_sample: u32,
    bytes_per_sample: u32,
};

pub fn resolvePcmLayout(descriptor: ?types.Descriptor) ?PcmLayout {
    const desc = descriptor orelse return null;
    const valid = desc.bits_per_sample orelse return null;
    const stored = desc.stored_bits_per_sample orelse valid;
    if ((stored != 16 and stored != 24 and stored != 32) or valid < 1 or valid > stored) return null;
    return .{
        .valid_bits_per_sample = valid,
        .stored_bits_per_sample = stored,
        .bytes_per_sample = stored / 8,
    };
}

pub fn readSample(src: []const u8, offset: usize, layout: PcmLayout) f32 {
    var signed: i32 = undefined;
    if (layout.stored_bits_per_sample == 16) {
        signed = @as(i16, @bitCast(std.mem.readInt(u16, src[offset..][0..2], .little)));
    } else if (layout.stored_bits_per_sample == 24) {
        const value: u32 = src[offset] | (@as(u32, src[offset + 1]) << 8) | (@as(u32, src[offset + 2]) << 16);
        signed = if ((value & 0x800000) != 0) @as(i32, @bitCast(value)) - 0x1000000 else @intCast(value);
    } else {
        signed = @bitCast(std.mem.readInt(u32, src[offset..][0..4], .little));
    }
    const padding: u5 = @intCast(layout.stored_bits_per_sample - layout.valid_bits_per_sample);
    const valid_sample = if (padding == 0) signed else signed >> padding;
    const denom = @as(f32, @floatFromInt(@as(u32, 1) << @intCast(layout.valid_bits_per_sample - 1)));
    return @as(f32, @floatFromInt(valid_sample)) / denom;
}

pub fn unpackToF32(dest: []f32, src: []const u8, layout: PcmLayout, channels: u32) void {
    const frame_bytes = layout.bytes_per_sample * channels;
    const frames = src.len / frame_bytes;
    var i: usize = 0;
    while (i < frames) : (i += 1) {
        var ch: u32 = 0;
        while (ch < channels) : (ch += 1) {
            const off = i * frame_bytes + ch * layout.bytes_per_sample;
            dest[i * channels + ch] = readSample(src, off, layout);
        }
    }
}

const std = @import("std");
