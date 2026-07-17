#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <vector>

#include "R3DSDK.h"

using namespace R3DSDK;

namespace {

VideoDecodeMode decodeMode(const char* quality) {
  if (std::strcmp(quality, "full") == 0) return DECODE_FULL_RES_PREMIUM;
  if (std::strcmp(quality, "half") == 0) return DECODE_HALF_RES_GOOD;
  if (std::strcmp(quality, "quarter") == 0) return DECODE_QUARTER_RES_GOOD;
  std::fprintf(stderr, "quality must be full, half, or quarter\n");
  std::exit(2);
}

std::size_t divisor(const char* quality) {
  if (std::strcmp(quality, "full") == 0) return 1;
  if (std::strcmp(quality, "half") == 0) return 2;
  return 4;
}

bool writePlane(const std::uint16_t* plane, std::size_t pixelCount) {
  return std::fwrite(plane, sizeof(std::uint16_t), pixelCount, stdout) == pixelCount;
}

}  // namespace

int main(int argc, char** argv) {
  if (argc != 6) {
    std::fprintf(stderr,
                 "usage: %s <sdk-redist> <clip.r3d> <start-frame> <frame-count> "
                 "<full|half|quarter>\n",
                 argv[0]);
    return 2;
  }

  const char* sdkPath = argv[1];
  const char* clipPath = argv[2];
  const std::size_t startFrame = std::strtoull(argv[3], nullptr, 10);
  const std::size_t requestedFrames = std::strtoull(argv[4], nullptr, 10);
  const char* quality = argv[5];
  const VideoDecodeMode mode = decodeMode(quality);

  if (InitializeSdk(sdkPath, OPTION_RED_NONE) != ISInitializeOK) {
    std::fprintf(stderr, "RED SDK initialization failed\n");
    return 1;
  }

  int exitCode = 0;
  {
    Clip clip(clipPath);
    if (clip.Status() != LSClipLoaded) {
      std::fprintf(stderr, "could not load %s\n", clipPath);
      exitCode = 1;
    } else if (startFrame >= clip.VideoFrameCount()) {
      std::fprintf(stderr, "start frame is outside the clip\n");
      exitCode = 1;
    } else {
      const std::size_t frameCount =
          std::min(requestedFrames, clip.VideoFrameCount() - startFrame);
      const std::size_t width = clip.Width() / divisor(quality);
      const std::size_t height = clip.Height() / divisor(quality);
      const std::size_t pixelCount = width * height;
      const std::size_t bufferBytes = pixelCount * 3 * sizeof(std::uint16_t);
      std::vector<std::uint8_t> storage(bufferBytes + 15);
      std::uint8_t* aligned = storage.data();
      const auto address = reinterpret_cast<std::uintptr_t>(aligned);
      if (address % 16 != 0) aligned += 16 - (address % 16);

      ImageProcessingSettings settings;
      clip.GetClipImageProcessingSettings(settings);
      settings.ImagePipelineMode = Primary_Development_Only;
      settings.ColorSpace = ImageColorREDWideGamutRGB;
      settings.GammaCurve = ImageGammaLog3G10;
      if (settings.Lut3D) {
        Handle3DLut handle = settings.Lut3D;
        Unload3DLut(&handle);
        settings.Lut3D = nullptr;
      }
      settings.Lut3DEnabled = false;
      settings.CheckBounds();

      VideoDecodeJob job;
      job.OutputBufferSize = bufferBytes;
      job.Mode = mode;
      job.OutputBuffer = aligned;
      job.PixelType = PixelType_16Bit_RGB_Planar;
      job.ImageProcessing = &settings;

      std::fprintf(stderr,
                   "R3D: %zux%zu @ %.6g fps; streaming %zu frames as "
                   "%zux%zu gbrp16le RWG/Log3G10\n",
                   clip.Width(), clip.Height(), clip.VideoAudioFramerate(), frameCount,
                   width, height);

      for (std::size_t offset = 0; offset < frameCount; ++offset) {
        const std::size_t frame = startFrame + offset;
        if (clip.DecodeVideoFrame(frame, job) != DSDecodeOK) {
          std::fprintf(stderr, "decode failed at frame %zu\n", frame);
          exitCode = 1;
          break;
        }

        const auto* red = reinterpret_cast<const std::uint16_t*>(aligned);
        const auto* green = red + pixelCount;
        const auto* blue = green + pixelCount;
        // FFmpeg's planar GBR layout is G, B, R.
        if (!writePlane(green, pixelCount) || !writePlane(blue, pixelCount) ||
            !writePlane(red, pixelCount)) {
          std::fprintf(stderr, "raw-video pipe closed at frame %zu\n", frame);
          exitCode = 1;
          break;
        }
        if ((offset + 1) % 12 == 0 || offset + 1 == frameCount) {
          std::fprintf(stderr, "decoded %zu/%zu frames\r", offset + 1, frameCount);
        }
      }
      std::fprintf(stderr, "\n");
    }
  }

  FinalizeSdk();
  return exitCode;
}
