package generator

// IDGenerator defines the contract for generating unique order numbers.
type IDGenerator interface {
	// Generate generates a single unique 14-digit order number.
	Generate() (string, error)
	// GenerateBatch generates a batch of count unique 14-digit order numbers.
	GenerateBatch(count int) ([]string, error)
}
