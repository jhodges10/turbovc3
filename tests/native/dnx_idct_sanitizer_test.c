#include <assert.h>
#include <stdint.h>
#include <string.h>

void dnx_idct_i32_blocks(const int32_t* coeffs, uint16_t* samples, uint32_t block_count, uint32_t bit_depth);
uint32_t dnx_idct_kernel_version(void);

int main(void) {
  int32_t coefficients[4 * 64];
  uint16_t samples[4 * 64];
  memset(coefficients, 0, sizeof(coefficients));
  memset(samples, 0, sizeof(samples));
  coefficients[0] = 1024;
  coefficients[64] = -1024;
  for (uint32_t index = 128; index < 4 * 64; index += 1) {
    coefficients[index] = index % 2 == 0 ? 32767 : -32768;
  }

  assert(dnx_idct_kernel_version() == 1);
  dnx_idct_i32_blocks(coefficients, samples, 4, 12);
  for (uint32_t index = 0; index < 4 * 64; index += 1) {
    assert(samples[index] <= 4095);
  }
  samples[0] = 1234;
  dnx_idct_i32_blocks(coefficients, samples, 1, 32);
  assert(samples[0] == 1234);
  dnx_idct_i32_blocks(0, samples, 1, 8);
  dnx_idct_i32_blocks(coefficients, 0, 1, 8);
  return 0;
}
