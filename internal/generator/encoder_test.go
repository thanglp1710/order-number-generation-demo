package generator

import (
	"testing"
)

func TestCalculateLuhn(t *testing.T) {
	tests := []struct {
		input    string
		expected int
	}{
		{"7992739871", 3},  // 79927398713 is valid
		{"4992739871", 6},  // 49927398716 is valid
		{"4837291846523", 5}, // 48372918465235 is valid
	}

	for _, tt := range tests {
		t.Run(tt.input, func(t *testing.T) {
			got := CalculateLuhn(tt.input)
			if got != tt.expected {
				t.Errorf("CalculateLuhn(%q) = %d; want %d", tt.input, got, tt.expected)
			}
		})
	}
}

func TestVerifyLuhn(t *testing.T) {
	tests := []struct {
		input    string
		expected bool
	}{
		{"79927398713", true},
		{"49927398716", true},
		{"48372918465235", true},
		{"48372918465237", false}, // wrong check digit
		{"00000000000000", true},
		{"00000000000001", false},
	}

	for _, tt := range tests {
		t.Run(tt.input, func(t *testing.T) {
			got := VerifyLuhn(tt.input)
			if got != tt.expected {
				t.Errorf("VerifyLuhn(%q) = %t; want %t", tt.input, got, tt.expected)
			}
		})
	}
}
