package generator

// CalculateLuhn calculates the Luhn check digit for a given numeric string of any length.
// It assumes that the check digit will be appended at the end (making it the 1st digit from the right).
// Therefore, the digit preceding it (index len-1) will be at an even position from the right (doubled).
func CalculateLuhn(number string) int {
	sum := 0
	n := len(number)
	for i := 0; i < n; i++ {
		digit := int(number[i] - '0')
		// The position from the right (1-based, assuming check digit is at pos 1)
		// for index i is (n + 1 - i).
		// Check digit is at position 1 (odd).
		// Index i will be at position (n + 1 - i) from the right.
		// If (n + 1 - i) is even, we double the digit.
		posFromRight := n + 1 - i
		if posFromRight%2 == 0 {
			digit *= 2
			if digit > 9 {
				digit -= 9
			}
		}
		sum += digit
	}
	return (10 - (sum % 10)) % 10
}

// VerifyLuhn verifies that the given numeric string (including the check digit) satisfies the Luhn algorithm.
func VerifyLuhn(number string) bool {
	sum := 0
	n := len(number)
	for i := 0; i < n; i++ {
		digit := int(number[i] - '0')
		// The position from the right is (n - i).
		// Position 1 (the check digit itself) is odd, position 2 is even, etc.
		posFromRight := n - i
		if posFromRight%2 == 0 {
			digit *= 2
			if digit > 9 {
				digit -= 9
			}
		}
		sum += digit
	}
	return sum%10 == 0
}
