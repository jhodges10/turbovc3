pub const binary = @import("binary.zig");
pub const types = @import("types.zig");
pub const index = @import("index.zig");
pub const pcm = @import("pcm.zig");
pub const demux = @import("demux.zig");

pub const Reader = demux.Reader;
pub const Demux = demux.Demux;
pub const demuxFile = demux.demux;
pub const PcmLayout = pcm.PcmLayout;
pub const resolvePcmLayout = pcm.resolvePcmLayout;
pub const unpackPcmToF32 = pcm.unpackToF32;

test {
    _ = binary;
    _ = types;
    _ = index;
    _ = pcm;
    _ = demux;
}
