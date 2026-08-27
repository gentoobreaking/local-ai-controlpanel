from pydantic import BaseModel, field_validator
    """
    class UploadModel(BaseModel):
        file: bytes

        @field_validator("file")
        def validate_file(cls, v):
            return v.read()
