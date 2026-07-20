const std = @import("std");
const turbovc3 = @import("turbovc3");

pub fn main(init: std.process.Init) !void {
    const allocator = init.gpa;
    const io = init.io;

    var args = init.minimal.args.iterate();
    _ = args.next();
    const path = args.next() orelse {
        std.debug.print("usage: decode_frame0 <file.mxf>\n", .{});
        return error.MissingPath;
    };

    var file_reader = try turbovc3.FileReader.open(io, path);
    defer file_reader.deinit();
    const source = file_reader.reader();

    var demuxed = try turbovc3.mxf.demuxFile(allocator, source, .{});
    defer demuxed.deinit();

    std.debug.print("tracks={d} packets={d}\n", .{ demuxed.tracks.len, demuxed.packets.len });
    for (demuxed.tracks, 0..) |track, i| {
        std.debug.print("track[{d}] kind={s} number={x} body={d} packets={d} rate={d}/{d}\n", .{
            i, @tagName(track.kind), track.number, track.body_sid, track.packet_count, track.edit_rate.numerator, track.edit_rate.denominator,
        });
    }

    const video = demuxed.primaryVideoTrack() orelse return error.NoVideoTrack;
    var iter = demuxed.packetsForTrack(video);
    const meta = iter.next() orelse return error.NoPackets;
    std.debug.print("packet offset={d} length={d}\n", .{ meta.byte_offset, meta.byte_length });
    const packet = try demuxed.readPacket(source, meta);
    defer allocator.free(packet);

    if (turbovc3.dnx.parseFrameHeader(packet)) |h| {
        std.debug.print("cid={d} bit={d} interlaced={} is444={} w={d} h={d} mbh={d} data_off={d} supported={}\n", .{
            h.cid, h.bit_depth, h.interlaced, h.is_444, h.width, h.height, h.macroblock_height, h.data_offset, h.supported,
        });
    } else std.debug.print("header null\n", .{});

    var frame = try turbovc3.dnx.decodeFrameRgb8(allocator, packet);
    defer frame.deinit();
    const checksum = std.hash.Wyhash.hash(0, frame.data);
    std.debug.print("frame0 {d}x{d} stride={d} bytes={d} checksum={x}\n", .{
        frame.width, frame.height, frame.stride_bytes, frame.data.len, checksum,
    });
}
